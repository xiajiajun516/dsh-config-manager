/**
 * m2: 模块级 run/UI store —— dsh-config-manager 浏览器半的状态中枢。
 *
 * 解决的问题（验收 m2-state / m2-refresh / m2-resume）：
 *  - 切 tab / 关面板重开：模块级单例存活于当前 JS 上下文，ExportFlow /
 *    ImportWizard 控制器实例与 UI 状态**不重建**（m2-state）；
 *  - 页面刷新：非敏感状态经 sessionStorage（键 dsh.cfgMgr.state.v1）
 *    序列化/反序列化恢复（m2-refresh）；敏感字段
 *    password / passwordConfirm / secretInputs **只存在内存**，序列化白名单
 *    显式剔除 —— 刷新后自动清空，secrets 阶段要求重输；
 *  - 进行中 run：视图挂载时经 GET /runs 找回活跃 runId，轮询 GET /progress
 *    直到完成/失败，把 RunState.result 回填到 store（m2-resume）。服务端在
 *    刷新/关面板期间继续执行，本 store 只负责重新订阅进度。
 *
 * 控制器 rehydrate 说明：ImportWizard 没有公开的 hydrate 入口（m2 约束为只改
 * src/client/、不动 src/ui/），刷新恢复需要把持久化的非敏感快照写回控制器
 * 私有字段。writeWizardSnapshot() 是唯一的受控访问点：类型层 private 只是
 * 编译期约束（运行时是普通属性），所有写入值都来自序列化白名单（已剔除
 * 密码/密钥/secretInputs），且只在 load / hydrate / resume-settle 时调用。
 *
 * 安全约束：
 *  - toPersistedState() 用解构白名单剔除敏感字段，即使未来往 LiveState 加字段，
 *    未显式放行也不会落入 sessionStorage；
 *  - runId 为 32-hex 不可猜标识，可安全持久化（/runs + /progress 的查询键）。
 */
import { ConflictCollector } from '../ui/conflict-view.ts'
import { DEFAULT_CATEGORIES, ExportFlow } from '../ui/export-flow.ts'
import type { ExportRunResult } from '../ui/export-flow.ts'
import { ImportWizard } from '../ui/import-wizard.ts'
import { renderExportReport } from '../ui/report.ts'
import type { FlowPhase } from '../ui/flow.ts'
import type { ImportStep } from '../ui/types.ts'
import type { RunProgress } from './common/progress-view.ts'
import type {
  GlobalConflictStrategy, ImportAnalysis, ImportDecisions, ImportPlan, ImportResult,
  ItemResolution, PathMapping,
} from '../core/types.ts'
import type { RunKind, RunState } from '../core/run-registry.ts'
import type { Manifest, SectionId } from '../schema/types.ts'
import type { ConfigManagerApi } from './api.ts'

/* ---------------------------------------------------------------- 基础类型 */

/** 主视图（ConfigManagerSection 的 tab 状态）。 */
export type MainView = 'export' | 'import'

/** 导出模式。 */
export type ExportMode = 'quick' | 'custom'

/** 存储抽象（浏览器 sessionStorage / 测试 mock / 无存储）。 */
export interface StoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** sessionStorage 键。 */
export const STATE_KEY = 'dsh.cfgMgr.state.v1'

/** Custom 模式的初始勾选 = 推荐分区（可再调整） */
export function defaultCustomSelection(): SectionId[] {
  return DEFAULT_CATEGORIES
    .filter((c) => c.defaultIncluded)
    .map((c) => c.id)
}

/* ------------------------------------------------- 持久化（非敏感）状态形状 */

/** 导出视图的持久化切片（不含 password/passwordConfirm）。 */
export interface PersistedExportState {
  mode: ExportMode
  selection: SectionId[]
  /** 是否导出真实密钥（凭据值）；勾选时默认联动勾选 encrypt（密钥绝不明文） */
  includeSecrets: boolean
  /** 是否加密备份（独立选项；不导出密钥也可单独加密） */
  encrypt: boolean
  running: boolean
  progress: RunProgress | null
  result: ExportRunResult | null
  /** 错误消息（已 redact 的文本；Error 对象不可 JSON 序列化，统一转字符串） */
  error: string | null
  downloaded: boolean
  /** 最近一次导出 run id（/runs + /progress 重新订阅用；32-hex 不可猜） */
  runId: string | null
}

/** 导入向导的持久化切片（不含 secretInputs）。 */
export interface PersistedImportState {
  step: ImportStep
  zipPath: string | null
  /** select 步骤已选备份文件名（换选/取消选择的 UI 状态；非敏感） */
  selectedFileName: string | null
  /** 上传文件是否为整体加密备份容器（非敏感；UI 据此先进入解密容器阶段再分析） */
  containerEncrypted: boolean
  analysis: ImportAnalysis | null
  plan: ImportPlan | null
  result: ImportResult | null
  rollbackOnError: boolean
  errors: string[]
  /** UI 层流程阶段（wizard.step 之外的页面；见 src/ui/flow.ts） */
  phase: FlowPhase
  conflictStrategy: GlobalConflictStrategy
  conflictResolutions: Record<string, ItemResolution>
  pathMappings: PathMapping[]
  uploading: boolean
  running: boolean
  progress: RunProgress | null
  error: string | null
  runId: string | null
}

/** 刷新恢复的顶层持久化状态（v1 结构版本）。 */
export interface PersistedState {
  v: 1
  view: MainView
  export: PersistedExportState
  import: PersistedImportState
}

/* --------------------------------------- 运行时状态（含仅内存的敏感字段） */

/** 导出运行时状态 = 持久化字段 + 仅内存的密码字段。 */
export interface ExportLiveState extends PersistedExportState {
  /** 加密密码（仅内存，绝不写入 sessionStorage；刷新后清空） */
  password: string
  passwordConfirm: string
}

/** 导入运行时状态 = 持久化字段 + 仅内存的敏感/实例字段。 */
export interface ImportLiveState extends PersistedImportState {
  /** 秘密补录值（仅内存，绝不写入 sessionStorage；刷新后清空、secrets 阶段重输） */
  secretInputs: Record<string, string>
  /** 加密备份的解密密码（仅内存，绝不写入 sessionStorage；刷新后清空、decrypt 阶段重输） */
  decryptPassword: string
  /** 解密验证成功后覆盖的凭据 ref 名（仅内存、非值）；secrets 阶段据此剔除已恢复项 */
  decryptRefs: string[]
  /** 整体加密备份容器已解锁（仅内存；刷新后要求重输密码重新解锁） */
  archiveUnlocked: boolean
  /** 冲突决策收集器实例（仅内存；刷新后由 plan + conflictResolutions 重建） */
  conflictCollector: ConflictCollector | null
}

/** store 的完整运行时快照（getSnapshot 返回；含敏感字段，仅供组件读取）。 */
export interface StoreState {
  v: 1
  view: MainView
  export: ExportLiveState
  import: ImportLiveState
}

/** patch 的输入形状（浅合并对应切片）。 */
export interface StorePatch {
  view?: MainView
  export?: Partial<ExportLiveState>
  import?: Partial<ImportLiveState>
}

/** 向导 step 的类型别名（与 src/ui/types.ts 的 ImportStep 保持一致）。 */
type ImportWizardStep = ImportStep

/* ------------------------------------------------------------- 默认值 */

function defaultExportState(): ExportLiveState {
  return {
    mode: 'quick',
    selection: defaultCustomSelection(),
    includeSecrets: false,
    encrypt: false,
    password: '',
    passwordConfirm: '',
    running: false,
    progress: null,
    result: null,
    error: null,
    downloaded: false,
    runId: null,
  }
}

function defaultImportState(): ImportLiveState {
  return {
    step: 'select',
    zipPath: null,
    selectedFileName: null,
    containerEncrypted: false,
    analysis: null,
    plan: null,
    result: null,
    rollbackOnError: true,
    errors: [],
    phase: 'preview',
    conflictStrategy: 'merge',
    conflictResolutions: {},
    pathMappings: [],
    secretInputs: {},
    decryptPassword: '',
    decryptRefs: [],
    archiveUnlocked: false,
    uploading: false,
    running: false,
    progress: null,
    error: null,
    runId: null,
    conflictCollector: null,
  }
}

function defaultState(): StoreState {
  return {
    v: 1,
    view: 'export',
    export: defaultExportState(),
    import: defaultImportState(),
  }
}

/* ------------------------------------------------- 序列化白名单（安全关键） */

/**
 * 持久化白名单：解构剔除敏感字段（password/passwordConfirm/secretInputs/decryptPassword）
 * 与不可序列化的实例字段（conflictCollector），其余原样落入 sessionStorage。
 * 这是 sessionStorage 的唯一写入路径 —— 敏感值在此被硬性隔离。
 */
export function toPersistedState(state: StoreState): PersistedState {
  const { password: _password, passwordConfirm: _passwordConfirm, ...exportRest } = state.export
  const {
    secretInputs: _secretInputs, decryptPassword: _decryptPassword, decryptRefs: _decryptRefs,
    archiveUnlocked: _archiveUnlocked, conflictCollector: _conflictCollector, ...importRest
  } = state.import
  return { v: 1, view: state.view, export: exportRest, import: importRest }
}

/** 解析 + 轻量校验持久化状态；损坏/版本不符返回 null（调用方回退默认并清键）。 */
export function parsePersistedState(raw: string): PersistedState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p['v'] !== 1) return null
  const view = p['view']
  if (view !== 'export' && view !== 'import') return null
  const exp = p['export']
  const imp = p['import']
  if (typeof exp !== 'object' || exp === null || typeof imp !== 'object' || imp === null) return null
  return { v: 1, view, export: exp as PersistedExportState, import: imp as PersistedImportState }
}

/* ----------------------------------------------------- 控制器 rehydrate */

/** ImportWizard 私有字段的镜像形状（仅供 writeWizardSnapshot 受控写入）。 */
interface WizardInternals {
  step: ImportWizardStep
  zipPath: string | null
  analysis: ImportAnalysis | null
  plan: ImportPlan | null
  result: ImportResult | null
  rollbackOnError: boolean
  errors: string[]
  decisions: ImportDecisions
  secretInputs: Record<string, string>
  decryptPassword: string
  archiveUnlocked: boolean
  unlockedZipPath: string | null
}

/**
 * 把 store 的导入快照写回 ImportWizard 控制器私有字段（受控 rehydrate）。
 * - 只写非敏感字段；secretInputs / decryptPassword / archiveUnlocked / unlockedZipPath
 *   恒置空 —— 刷新后要求重输密码重新解锁容器；
 * - 仅在 load / hydrate / resume-settle 时调用，不参与正常交互路径。
 */
function writeWizardSnapshot(wizard: ImportWizard, imp: ImportLiveState): void {
  const internals = wizard as unknown as WizardInternals
  internals.step = imp.step
  internals.zipPath = imp.zipPath
  internals.analysis = imp.analysis
  internals.plan = imp.plan
  internals.result = imp.result
  internals.rollbackOnError = imp.rollbackOnError
  internals.errors = [...imp.errors]
  internals.decisions = {
    strategy: imp.conflictStrategy,
    resolutions: { ...imp.conflictResolutions },
    pathMappings: imp.pathMappings.map((m) => ({ ...m, appliesTo: [...m.appliesTo] })),
  }
  internals.secretInputs = {}
  internals.decryptPassword = ''
  internals.archiveUnlocked = false
  internals.unlockedZipPath = null
}

/** 由 plan + 已持久化的决策重建 ConflictCollector（刷新恢复用）。 */
export function rebuildConflictCollector(
  plan: ImportPlan,
  resolutions: Record<string, ItemResolution>,
): ConflictCollector {
  const collector = new ConflictCollector(plan)
  for (const [id, resolution] of Object.entries(resolutions)) {
    collector.resolve(id, resolution)
  }
  return collector
}

/**
 * RunState → RunProgress（m3 轮询进度回填）。
 * - step/total = 内部计数（百分比条按 item/itemTotal 推进）；
 * - section/sectionTotal 与 item/itemTotal 单独保留给分区徽章/内部计数徽章；
 * - detail = 当前项名（导出时恒为分区名，ProgressBar 侧会去冗余）。
 */
function mapRunProgress(kind: RunKind, state: RunState): RunProgress {
  return {
    stage: kind === 'export' ? 'exporting' : 'executing',
    detail: state.detail ?? undefined,
    step: state.item ?? undefined,
    total: state.itemTotal ?? undefined,
    section: state.section,
    sectionTotal: state.sectionTotal,
    item: state.item,
    itemTotal: state.itemTotal,
  }
}

/* ------------------------------------------------------------------- store */

export interface RunStoreOptions {
  /** 存储提供者；缺省 = window.sessionStorage（Node/无 window 时为 null） */
  storage?: StoreStorage | null
  /** 进度轮询间隔（测试注入小值；缺省 1000ms） */
  pollIntervalMs?: number
}

function defaultStorage(): StoreStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * 模块级单例 store：控制器实例 + React UI 状态 + sessionStorage 恢复。
 * 最小接口：subscribe / getSnapshot / load / save / patch / syncWizard /
 * exportFlow / importWizard / resume / stopResume。
 */
export class RunStore {
  private readonly storage: StoreStorage | null
  private readonly pollIntervalMs: number
  private readonly listeners = new Set<() => void>()
  private state: StoreState
  private exportFlowInst: ExportFlow | null = null
  private importWizardInst: ImportWizard | null = null
  private apiRef: ConfigManagerApi | null = null
  /** 正在轮询的 runId 集合（stopResume 清空；防重复订阅） */
  private readonly polling = new Set<string>()
  /** 每个 runId 至多一个挂起的轮询定时器（fire 后由下一次调度覆盖） */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 正在「发现进行中 run」的 kind 集合（watchRunning 活动标记；stopRunWatch/stopResume 清空） */
  private readonly watchActive = new Set<RunKind>()

  constructor(opts: RunStoreOptions = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage()
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000
    this.state = defaultState()
    this.load()
  }

  /* ------------------------------------------------------------- 订阅 */

  /**
   * 订阅 store 变化（useSyncExternalStore 的 subscribe）。
   *
   * 必须为箭头函数类字段：React 以裸引用（`runStore.subscribe`）调用它，
   * 无接收者，若为原型方法则 `this` 为 undefined，`this.listeners` 直接崩溃。
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 当前完整快照（引用稳定：仅在 patch 后替换，适合 useSyncExternalStore）。
   *
   * 必须为箭头函数类字段：React 以裸引用（`runStore.getSnapshot`）调用它，
   * 无接收者，若为原型方法则 `this` 为 undefined，`this.state` 抛 TypeError，
   * 导致整个 settings.section 槽位渲染崩溃（备份与迁移页空白）。
   */
  getSnapshot = (): StoreState => this.state

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /* ------------------------------------------------------- 状态更新 */

  /** 浅合并补丁并立即持久化（保存走白名单，敏感字段不落盘）。 */
  patch(patchObj: StorePatch): void {
    this.state = {
      ...this.state,
      view: patchObj.view ?? this.state.view,
      export: { ...this.state.export, ...patchObj.export },
      import: { ...this.state.import, ...patchObj.import },
    }
    this.notify()
    this.save()
  }

  /** 把 ImportWizard 控制器的 snapshot() 镜像进 store（wizard 动作后调用）。 */
  syncWizard(): void {
    const wizard = this.importWizardInst
    if (wizard === null) return
    const snap = wizard.snapshot()
    this.patch({
      import: {
        step: snap.step,
        zipPath: snap.zipPath,
        analysis: snap.analysis,
        plan: snap.plan,
        result: snap.result,
        rollbackOnError: snap.rollbackOnError,
        errors: snap.errors,
      },
    })
  }

  /* ------------------------------------------------------ 持久化 load/save */

  /** 从存储恢复非敏感状态（构造时调用一次；损坏数据回退默认并清键）。 */
  load(): void {
    if (this.storage === null) return
    let raw: string | null = null
    try {
      raw = this.storage.getItem(STATE_KEY)
    } catch {
      return
    }
    if (raw === null || raw === '') {
      this.state = defaultState()
      return
    }
    const parsed = parsePersistedState(raw)
    if (parsed === null) {
      // 损坏/版本不符：清掉脏键，回退默认
      try {
        this.storage.removeItem(STATE_KEY)
      } catch {
        // 忽略存储错误
      }
      this.state = defaultState()
      return
    }
    this.applyPersisted(parsed)
  }

  /** 把解析后的持久化状态合并进运行时状态；敏感字段强制回到默认（清空）。 */
  private applyPersisted(parsed: PersistedState): void {
    this.state = {
      v: 1,
      view: parsed.view,
      export: {
        ...defaultExportState(),
        ...parsed.export,
        // 硬性：密码/确认密码绝不从存储恢复
        password: '',
        passwordConfirm: '',
      },
      import: {
        ...defaultImportState(),
        ...parsed.import,
        // 旧版持久化载荷可能缺 selectedFileName（undefined）→ 归一到 null
        selectedFileName: parsed.import.selectedFileName ?? null,
        // 旧版持久化载荷可能缺 containerEncrypted（undefined）→ 归一到 false
        containerEncrypted: parsed.import.containerEncrypted === true,
        // 硬性：秘密补录值 / 解密密码 / 解密覆盖清单 / 容器解锁标志绝不从存储恢复；
        // collector 由 plan+决策重建
        secretInputs: {},
        decryptPassword: '',
        decryptRefs: [],
        archiveUnlocked: false,
        conflictCollector: null,
      },
    }
    // 安全兜底：整体加密备份容器已解锁标志绝不从存储恢复（archiveUnlocked 必为 false）→
    // 刷新后只要仍标记为加密容器且已越过 decrypt-archive 阶段，就强制退回重新解锁。
    if (
      this.state.import.containerEncrypted &&
      this.state.import.phase !== 'preview' &&
      this.state.import.phase !== 'decrypt-archive'
    ) {
      this.state.import.phase = 'decrypt-archive'
    }
    // 安全兜底：confirm 阶段若仍缺必填 secret（刷新后 secretInputs 必为空），
    // 强制退回 secrets 阶段要求重输（验收 m2-refresh 的「secrets 阶段要求重输」）。
    const missing = this.state.import.plan?.missingSecrets ?? []
    if (this.state.import.phase === 'confirm' && missing.length > 0) {
      this.state.import.phase = 'secrets'
    }
    // 安全兜底：加密备份的解密密码绝不从存储恢复（decryptPassword 必为空）→
    // 刷新后只要已越过解密阶段（conflicts/secrets/confirm）就强制退回解密阶段重输，
    // 否则执行时会被 core 的加密不变量拒绝（import.encryptedPasswordRequired）。
    // 容器加密备份（containerEncrypted）统一回到上面的 decrypt-archive 阶段，不做此分支。
    const analysis = this.state.import.analysis
    if (
      !this.state.import.containerEncrypted &&
      analysis?.encrypted === true &&
      this.state.import.decryptPassword === '' &&
      this.state.import.phase !== 'preview' &&
      this.state.import.phase !== 'decrypt'
    ) {
      this.state.import.phase = 'decrypt'
    }
    // 冲突阶段：由恢复后的 plan + 决策重建 collector（刷新后实例必然丢失）
    const imp = this.state.import
    if (imp.phase === 'conflicts' && imp.plan !== null) {
      imp.conflictCollector = rebuildConflictCollector(imp.plan, imp.conflictResolutions)
    }
  }

  /** 把非敏感状态写入 sessionStorage（白名单序列化；无存储时为空操作）。 */
  save(): void {
    if (this.storage === null) return
    try {
      this.storage.setItem(STATE_KEY, JSON.stringify(toPersistedState(this.state)))
    } catch {
      // 存储满/不可用：静默降级，状态仍完整存在于内存
    }
  }

  /* ---------------------------------------------------- 控制器实例（缓存） */

  /** ExportFlow 控制器实例：懒创建 + 缓存（切 tab/关面板不重建）。 */
  exportFlow(api: ConfigManagerApi): ExportFlow {
    if (this.exportFlowInst === null) {
      if (this.apiRef === null) this.apiRef = api
      this.exportFlowInst = new ExportFlow({
        port: api,
        onProgress: (event) => { this.patch({ export: { progress: event } }) },
      })
    }
    return this.exportFlowInst
  }

  /** ImportWizard 控制器实例：懒创建 + 缓存；首次创建时从持久化快照 rehydrate。 */
  importWizard(api: ConfigManagerApi): ImportWizard {
    if (this.importWizardInst === null) {
      if (this.apiRef === null) this.apiRef = api
      const wizard = new ImportWizard({
        port: api,
        onProgress: (event) => { this.patch({ import: { progress: event } }) },
        defaultRollbackOnError: true,
      })
      // 刷新恢复：把持久化快照写回控制器（仅非敏感字段；secretInputs 置空）
      writeWizardSnapshot(wizard, this.state.import)
      this.importWizardInst = wizard
    }
    return this.importWizardInst
  }

  /* ------------------------------------------------- m2-resume：run 重订阅 */

  /**
   * 重新订阅进行中的 run：GET /runs 找回活跃 runId → 轮询 /progress 直到
   * 完成/失败，把 RunState.result 回填 store（导出结果 / 导入结果均可恢复）。
   * 返回是否有 run 被恢复。幂等：同一 runId 不会重复轮询。
   */
  async resume(api: ConfigManagerApi): Promise<boolean> {
    if (this.apiRef === null) this.apiRef = api
    let active: RunState[]
    try {
      active = await api.runs()
    } catch {
      // host 不可达：保持现状，不做破坏性重置
      return false
    }
    let resumed = false
    const exportRun = active.find((r) => r.kind === 'export')
    if (exportRun !== undefined) {
      resumed = true
      this.patch({
        export: {
          running: true,
          runId: exportRun.runId,
          progress: mapRunProgress('export', exportRun),
        },
      })
      this.pollRun(exportRun.runId, 'export')
    } else if (this.state.export.running) {
      // 持久化显示导出中，但 host 无活跃导出 run：请求已结束且响应丢失，不可恢复
      this.patch({
        export: {
          running: false,
          progress: null,
          runId: null,
          error: '上次导出任务已结束但结果无法恢复，请重新导出',
        },
      })
    }

    const importRun = active.find((r) => r.kind === 'import')
    if (importRun !== undefined) {
      resumed = true
      this.patch({
        import: {
          running: true,
          runId: importRun.runId,
          step: 'importing',
          progress: mapRunProgress('import', importRun),
        },
      })
      this.pollRun(importRun.runId, 'import')
    } else if (this.state.import.step === 'importing') {
      // 持久化显示导入中，但 host 无活跃导入 run：任务已结束/被清理，结果不可恢复
      this.importWizardInst?.reset()
      this.patch({
        import: {
          step: 'select',
          phase: 'preview',
          runId: null,
          running: false,
          progress: null,
          conflictCollector: null,
          selectedFileName: null,
          errors: [],
          error: '上次导入任务已结束或超过保留期，结果无法恢复，请重新导入',
        },
      })
    }
    return resumed
  }

  /** 停止全部轮询（视图卸载时调用；服务端执行不受影响，重开面板再 resume）。 */
  stopResume(): void {
    this.polling.clear()
    this.watchActive.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /* ------------------------------------- m3：本次会话内启动 run 的实时轮询 */

  /**
   * 本次会话内启动的 run（POST /export 或 /execute 请求进行期间）的实时进度订阅。
   * 请求是同步的、响应到达才知 runId，所以先经 GET /runs 发现进行中的 run（500ms），
   * 发现后转入 /progress 轮询（同一间隔），done/failed 自动停止。
   *
   * 与 m2 resume 的收敛：两者共用 pollRun / polling / timers 同一套轮询器，
   * 只是间隔不同（resume 恢复 1s、本方法实时 500ms）且发现阶段不同
   * （resume 用 /runs 一次性找回 runId；本方法持续 /runs 直到出现活跃 run）。
   * 同一 runId 不会重复轮询（polling 集合防重）。
   */
  watchRunning(kind: RunKind, intervalMs?: number): void {
    if (this.watchActive.has(kind)) return
    this.watchActive.add(kind)
    const api = this.apiRef
    if (api === null) {
      this.watchActive.delete(kind)
      return
    }
    const interval = intervalMs ?? this.pollIntervalMs
    const tick = (): void => {
      if (!this.watchActive.has(kind)) return
      void api.runs().then(
        (active) => {
          if (!this.watchActive.has(kind)) return
          const run = active.find((r) => r.kind === kind && r.status === 'running')
          if (run === undefined) {
            // 请求尚未注册 run / 已瞬间结束：继续发现，直到视图 stop 或转入 /progress
            this.scheduleWatch(kind, tick, interval)
            return
          }
          // 发现进行中 run：停止发现，交给 /progress 轮询器（同一间隔）
          this.watchActive.delete(kind)
          this.patchProgress(kind, run)
          this.pollRun(run.runId, kind, interval)
        },
        () => {
          if (this.watchActive.has(kind)) this.scheduleWatch(kind, tick, interval)
        },
      )
    }
    this.scheduleWatch(kind, tick, interval)
  }

  /** 停止某 kind 的「发现进行中 run」轮询（视图请求结束后调用；/progress 轮询自行结束）。 */
  stopRunWatch(kind: RunKind): void {
    this.watchActive.delete(kind)
  }

  /** 调度下一轮发现；每 kind 只保留一个挂起定时器。 */
  private scheduleWatch(kind: RunKind, tick: () => void, intervalMs: number): void {
    const timer = setTimeout(tick, intervalMs)
    this.timers.set(`watch:${kind}`, timer)
  }

  private pollRun(runId: string, kind: RunKind, intervalMs?: number): void {
    if (this.polling.has(runId)) return
    this.polling.add(runId)
    const api = this.apiRef
    if (api === null) return
    const interval = intervalMs ?? this.pollIntervalMs
    const tick = (): void => {
      if (!this.polling.has(runId)) return
      void api.progress(runId).then(
        (state) => {
          if (!this.polling.has(runId)) return
          if (state.status === 'running') {
            this.patchProgress(kind, state)
            this.scheduleTick(runId, tick, interval)
          } else {
            this.polling.delete(runId)
            this.applySettled(kind, state)
          }
        },
        () => {
          // 404（过保留期）/网络错误：run 不可恢复，停止轮询并如实提示
          this.polling.delete(runId)
          this.applyGone(kind)
        },
      )
    }
    this.scheduleTick(runId, tick, interval)
  }

  /** 调度下一轮询；每 runId 只保留一个挂起定时器（fire 后由下一次调度覆盖）。 */
  private scheduleTick(runId: string, tick: () => void, intervalMs: number): void {
    const timer = setTimeout(tick, intervalMs)
    this.timers.set(runId, timer)
  }

  private patchProgress(kind: RunKind, state: RunState): void {
    const event = mapRunProgress(kind, state)
    if (kind === 'export') this.patch({ export: { progress: event } })
    else this.patch({ import: { progress: event } })
  }

  /** run 完成/失败：把 RunState.result 回填 store（并镜像回控制器）。 */
  private applySettled(kind: RunKind, state: RunState): void {
    if (kind === 'export') {
      const result = state.result as
        | { zipPath: string; manifest: Manifest; report: ExportRunResult['report'] }
        | undefined
      if (state.status === 'done' && result !== undefined && typeof result.zipPath === 'string') {
        this.patch({
          export: {
            running: false,
            progress: { stage: 'done', step: 1, total: 1 },
            result: { ...result, text: renderExportReport(result.report) },
            downloaded: false,
          },
        })
      } else {
        this.patch({
          export: {
            running: false,
            progress: null,
            result: null,
            downloaded: false,
            error: state.error ?? '导出失败（结果不可用）',
          },
        })
      }
      return
    }
    // import
    const result = state.result as ImportResult | undefined
    if (state.status === 'done' && result !== undefined && typeof result === 'object') {
      const wizard = this.importWizardInst
      if (wizard !== null) {
        const imp: ImportLiveState = {
          ...this.state.import,
          step: 'result',
          result,
          secretInputs: {},
          decryptPassword: '',
          decryptRefs: [],
          conflictCollector: null,
        }
        writeWizardSnapshot(wizard, imp)
      }
      this.patch({
        import: {
          step: 'result',
          result,
          running: false,
          progress: { stage: 'done', step: 1, total: 1 },
          error: null,
        },
      })
    } else {
      const wizard = this.importWizardInst
      if (wizard !== null) {
        const internals = wizard as unknown as WizardInternals
        internals.errors = [...internals.errors, state.error ?? '导入失败']
      }
      this.patch({
        import: {
          running: false,
          progress: null,
          error: state.error ?? '导入失败',
          errors: [...this.state.import.errors, state.error ?? '导入失败'],
        },
      })
    }
  }

  /** run 消失（404/网络错误）：停止轮询并提示不可恢复。 */
  private applyGone(kind: RunKind): void {
    if (kind === 'export') {
      this.patch({
        export: {
          running: false,
          progress: null,
          runId: null,
          error: '任务已结束或超过保留期，进度不可恢复',
        },
      })
    } else {
      this.importWizardInst?.reset()
      this.patch({
        import: {
          running: false,
          progress: null,
          runId: null,
          step: 'select',
          phase: 'preview',
          conflictCollector: null,
          selectedFileName: null,
          errors: [],
          error: '任务已结束或超过保留期，进度不可恢复',
        },
      })
    }
  }
}

/** 模块级单例（浏览器半所有视图共享；构造时自动 load()）。 */
export const runStore = new RunStore()
