/**
 * 宿主斜杠命令 /rollback（别名 /rw）—— 不打开设置面板也能回退（对齐 dsh-rewind 的 /rewind、/undo）。
 *
 * 语义（用户 2026-10-12 确认方案 A）：
 *   /rollback            → 当前**会话**的可回退点列表（回合号 / 时间 / 类型 / 状态 / 可回退性）
 *   /rollback <id>       → 回退到该点，走**与 HTTP 路由同源**的那道写入门：
 *                          runWithMutationLock（= SAFE MODE 门 + 跨进程/跨 kind 环境锁）
 *                          → 引擎 preview（零写入）→ 引擎 rewind（userConfirmed=true）
 *   引擎回的 confirmation-required / protected-point / record-incomplete 一律翻成可读错误结果，
 *   **绝不绕过**（命令入口没有「确认按钮」，用户敲下 id 就是那次确认；其余门照旧全量生效）。
 *
 * 纪律（与 src/core/model-tools.ts 的 registerModelTools 同口径）：
 *  · 命令服务**惰取**：一律 ctx.get('commands')，绝不属性访问 ctx.commands、绝不放进 inject ——
 *    未组合该服务的部署必须照常启动（命令是可选能力，不是硬依赖）；
 *    **读的时机是装配期一次**（见 registerRollbackCommand）：Cordis 的 ctx.get 在 apply 期只能拿到
 *    **已 apply** 的服务，所以 `commands` 行晚于本插件时 `/rollback` 不会注册（只 warn 一行、无重试入口）。
 *    DSH 内置插件与本插件的实际 apply 顺序**未坐实**（asar 不可直接读、本机 profile 无相关行）；
 *    要彻底消除这个窗口需要 `ctx.inject(['commands'])` 式的「服务就绪再注册」回调 —— 未做，如实记在这里。
 *  · 注册失败只 warn：命令挂不上不得影响其它装配（宿主启动 = blocker）；
 *  · 用户可见文案一律走宿主字典 engineMsg（key: command.rollback.*），**取文案那一刻**解析语言；
 *  · 本模块不 import @deepseek-ai/dsh-commands 的运行时值（只做结构化窄化），core 保持与 DSH 解耦。
 */

import { engineMsg } from './engine-locale.ts'
import { EnvironmentLockUnavailableError } from '../utils/env-lock.ts'
import type { MutationLockPort } from '../utils/env-lock.ts'
import type {
  RollbackPointSummary,
  RollbackRewindResult,
  RollbackSegmentResult,
} from './rollback-point.ts'

/**
 * 命令结果（与 @deepseek-ai/dsh-commands 的 `CommandResult` **逐字同形**）。
 *
 * 为什么在这里自己声明而不是 import 那门包的类型：`src/core/**` 的架构边界（tests/architecture-boundaries.test.ts
 * 的 core allow 表）只允许 node 内置 / core 内部 / schema / utils / security / migrations / js-yaml ——
 * `@deepseek-ai/*` 仅允许出现在 `src/index.ts` 与 `src/client/`。core 必须保持与 DSH 解耦，
 * 所以这里做**结构化窄化**；两边一旦漂移，`command-rollback.test.ts` 的编译期断言会红。
 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

/** 命令名（无前导斜杠）与别名。 */
export const ROLLBACK_COMMAND_NAME = 'rollback'
export const ROLLBACK_COMMAND_ALIAS = 'rw'

/**
 * 命令定义 id：/rw 别名是**第二条定义** —— 同一个 definitionId（客户端按 definitionId 做身份化行为，
 * 别名与主名必须被视作同一条命令）。
 */
export const ROLLBACK_COMMAND_DEFINITION_ID = 'dsh-config-manager/rollback'

/** 命令服务惰取回调（调用期读 ctx.get('commands')；未组合返回 undefined）。 */
export type CommandServiceReader = () => CommandServiceLike | undefined | null

/** 一条已注册命令的最小形状（避免把 DSH 类型变成本插件的硬依赖）。 */
export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly definitionId?: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  readonly handler: (invocation: CommandInvocationLike) => CommandResult | Promise<CommandResult>
}

/** 一次命令调用的最小形状（只读用到的字段）。 */
export interface CommandInvocationLike {
  readonly agent: unknown
  /** 命令名之后的原文（含分隔空白）。 */
  readonly rawInput: string
  /** 派发 UI 持有的取消信号（透传给回退执行）。 */
  readonly signal?: AbortSignal
}

/** 命令服务的最小形状（ctx.get('commands') 的结构化窄化）。 */
export interface CommandServiceLike {
  register(definition: CommandDefinitionLike): unknown
}

/** 宿主提供的回退能力（由 src/index.ts 装配；测试用假的实现即可）。 */
export interface RollbackCommandHost {
  /** 当前 agent 所属会话（拿不准则 ok:false —— 绝不猜）。 */
  agentSession(agent: unknown): AgentSessionFacts
  /** 列出该会话的回退点（含存储栈状态；只读）。 */
  list(sessionId: string): Promise<RollbackCommandListResult>
  /**
   * 执行回退：runWithMutationLock → SAFE MODE → 引擎 preview → 引擎 rewind。
   *
   * 被 SAFE MODE / 环境锁挡住时**抛 EnvironmentLockUnavailableError**（与 HTTP 路由同口径），
   * 由本模块翻成可读错误结果。
   */
  rewind(input: RollbackRewindExecution): Promise<RollbackRewindResult>
}

/**
 * 回退执行入参。
 *
 * 只带 id + 取消信号：引擎 `rewind({ id, userConfirmed: true })` 的**写入面**已经由该点的记录
 * 决定（不是调用方临时指定路径），多传会话/分块只会制造「两处口径」；会话事实只供只读列表过滤用。
 */
export interface RollbackRewindExecution {
  readonly id: string
  readonly signal?: AbortSignal
}

/** 列表结果（引擎 RollbackListResult 的可测子集）。 */
export interface RollbackCommandListResult {
  ok: boolean
  storage: { available: boolean; root: string; detail?: string }
  points: readonly RollbackPointSummary[]
  error?: string
}

/** 当前 agent 的会话事实（宽进严出：形状不符即 ok:false）。 */
export type AgentSessionFacts =
  | { ok: true; sessionId: string; chunks: readonly string[] }
  | { ok: false; detail: string }

/** 绝对路径判定（win32 盘符 + POSIX 前缀 + UNC；纯函数，不引 node:path）。 */
export function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * 从 agent 窄化会话事实。
 *
 * **不猜**：agent.session.id 读不出来就退回 agent.id（DSH 的 Agent.id 就是会话 id）；
 * 两者都读不出 → ok:false（命令如实报「拿不到当前会话」，而不是列全网的点）。
 * 工作区分块只认**绝对路径**的 cwd（与 rollbackSessionBindingOf 同一口径）。
 */
export function agentSessionFactsOf(agent: unknown): AgentSessionFacts {
  if (agent === null || typeof agent !== 'object') return { ok: false, detail: 'agent-not-object' }
  const rec = agent as { id?: unknown; session?: unknown }
  let sessionId: string | undefined
  let cwd: string | undefined
  const session = rec.session
  if (session !== null && typeof session === 'object') {
    const s = session as { id?: unknown; header?: unknown }
    if (typeof s.id === 'string' && s.id !== '') sessionId = s.id
    const header = s.header
    if (header !== null && typeof header === 'object') {
      const value = (header as { cwd?: unknown }).cwd
      if (typeof value === 'string' && value !== '') cwd = value
    }
  }
  if (sessionId === undefined && typeof rec.id === 'string' && rec.id !== '') sessionId = rec.id
  if (sessionId === undefined) return { ok: false, detail: 'session-id-missing' }
  const chunks = cwd !== undefined && isAbsolutePath(cwd) ? [cwd] : []
  return { ok: true, sessionId, chunks }
}

/** 解析结果：空输入 = 只读列表；单个 token = 目标点 id；其余 = invalid。 */
export type RollbackCommandInput =
  | { kind: 'list' }
  | { kind: 'rewind'; id: string }
  | { kind: 'invalid'; detail: string }

/**
 * 解析 rawInput（命令名之后的原文，含分隔空白）。
 * 语法只有两种：空 = 列表；单个非空 token = 目标 id。多 token 一律 invalid。
 */
export function parseRollbackCommand(rawInput: string): RollbackCommandInput {
  const trimmed = (rawInput ?? '').trim()
  if (trimmed === '') return { kind: 'list' }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 1) return { kind: 'invalid', detail: 'too-many-arguments' }
  return { kind: 'rewind', id: parts[0] ?? '' }
}

/* ------------------------------------------------------------------ 渲染 */

function isoOf(createdAt: number): string {
  if (!Number.isFinite(createdAt)) return '?'
  try {
    return new Date(createdAt).toISOString()
  } catch {
    return '?'
  }
}

/** 点状态：受保护 / 捕获不完整 / 正常（三者互斥，按引擎字段的优先级分派）。 */
function stateLabel(point: RollbackPointSummary): string {
  if (point.protected) return engineMsg('command.rollback.stateProtected')
  if (point.incomplete) return engineMsg('command.rollback.stateIncomplete')
  return engineMsg('command.rollback.stateNormal')
}

/** 该点两态各自的「可回退 / 不可回退」摘要（诚实：按段逐项说，再给总判）。 */
function restorableLabel(point: RollbackPointSummary): string {
  const segments = point.segments ?? []
  const parts: string[] = []
  for (const segment of segments) {
    const label = segment.restorable ? engineMsg('command.rollback.restorableYes') : engineMsg('command.rollback.restorableNo')
    parts.push(
      engineMsg('command.rollback.segmentLabel', {
        state: engineMsg(segment.state === 'workspace' ? 'command.rollback.segmentWorkspace' : 'command.rollback.segmentSession'),
        label,
      }),
    )
  }
  if (parts.length === 0) return engineMsg('command.rollback.restorableNo')
  const any = segments.some((segment) => segment.restorable)
  return engineMsg('command.rollback.restorableSummary', {
    parts: parts.join(engineMsg('command.rollback.listSeparator')),
    verdict: any ? engineMsg('command.rollback.restorableYes') : engineMsg('command.rollback.restorableNo'),
  })
}

function turnLabel(point: RollbackPointSummary): string {
  return point.turn === null ? engineMsg('command.rollback.turnUnknown') : String(point.turn)
}

function kindLabel(point: RollbackPointSummary): string {
  return engineMsg(point.kind === 'guard' ? 'command.rollback.kindGuard' : 'command.rollback.kindAuto')
}

/** 渲染只读列表（本会话没有点时给「本会话没有」，绝不冒充「全库为空」）。 */
export function renderRollbackList(result: RollbackCommandListResult, sessionId: string): CommandResult {
  if (!result.storage.available) {
    return {
      kind: 'error',
      text: engineMsg('command.rollback.storageUnavailable', { detail: result.storage.detail ?? result.storage.root }),
    }
  }
  if (result.error !== undefined && result.error !== '') {
    return { kind: 'error', text: engineMsg('command.rollback.listFailed', { detail: result.error }) }
  }
  const points = (result.points ?? []).filter((point) => point.sessionId === sessionId)
  if (points.length === 0) return { kind: 'error', text: engineMsg('command.rollback.empty') }
  const lines = points.map((point, index) =>
    engineMsg('command.rollback.listRow', {
      index: String(index + 1),
      id: point.id,
      turn: turnLabel(point),
      createdAt: isoOf(point.createdAt),
      kind: kindLabel(point),
      state: stateLabel(point),
      restorable: restorableLabel(point),
    }),
  )
  return { kind: 'success', text: [engineMsg('command.rollback.listTitle'), ...lines].join('\n') }
}

/** 段结果的一行技术事实（定位失败用；**不是**文案分派的语义依据）。 */
function segmentFacts(segments: readonly RollbackSegmentResult[] | undefined): string {
  if (segments === undefined || segments.length === 0) return ''
  return segments
    .map((segment) => segment.state + '/' + segment.status + (segment.reasonCode !== undefined ? '(' + segment.reasonCode + ')' : ''))
    .join(',')
}

/** 把引擎结果翻成命令结果（失败一律带机器码 + 技术细节；processed 的段事实不隐藏）。 */
export function renderRewindResult(result: RollbackRewindResult, id: string): CommandResult {
  const detail = result.detail ?? ''
  if (result.ok && result.outcome === 'restored') {
    return { kind: 'success', text: engineMsg('command.rollback.rewindRestored', { id, detail }) }
  }
  if (result.outcome === 'partial') {
    // 「部分恢复」既不是成功也不是泛化失败：逐段事实必须上屏（含被跳过的段）。
    return {
      kind: 'error',
      text: engineMsg('command.rollback.rewindPartial', {
        id,
        segments: engineMsg('command.rollback.segmentFacts', { facts: segmentFacts(result.segments) }),
        detail,
      }),
    }
  }
  return {
    kind: 'error',
    text: engineMsg('command.rollback.rewindFailed', { id, code: String(result.code), detail }),
  }
}

/* ------------------------------------------------------------------ 执行 */

/** 命令依赖（index.ts 装配；测试直接构造）。 */
export interface RollbackCommandDeps {
  readonly host: RollbackCommandHost
  /** mutation lock 端口（index.ts 传 host.mutationLock；测试可传 undefined 或假端口）。 */
  readonly mutationLock?: MutationLockPort
  /** SAFE MODE 同步谓词（与 HTTP 路由同一份 host.safeModeIsBlocked）。 */
  readonly isBlocked?: () => boolean
}

/**
 * 构造命令处理器（**纯编排**：不注册、不读 ctx）。
 *
 * 带参数时：parser → agentSession（只用于「这次是不是列表」的会话判定）→ host.rewind。
 * host.rewind 内部才是那道门：runWithMutationLock → SAFE MODE → 引擎 preview → 引擎 rewind
 * EnvironmentLockUnavailableError（SAFE MODE / 环境锁被挡）在此翻成可读错误结果。
 * 任何未预期异常也翻成错误结果 —— 命令处理器抛异常会让整条命令生命周期报泛化失败，
 * UI 只看到一句「失败」；这里如实把原因说清楚。
 */
export function makeRollbackCommandHandler(
  deps: RollbackCommandDeps,
): (invocation: CommandInvocationLike) => Promise<CommandResult> {
  return async (invocation) => {
    const parsed = parseRollbackCommand(invocation.rawInput)
    if (parsed.kind === 'invalid') {
      return { kind: 'error', text: engineMsg('command.rollback.usageInvalid', { detail: parsed.detail }) }
    }
    const facts = deps.host.agentSession(invocation.agent)
    if (!facts.ok) {
      return { kind: 'error', text: engineMsg('command.rollback.sessionUnavailable', { detail: facts.detail }) }
    }
    if (parsed.kind === 'list') {
      try {
        return renderRollbackList(await deps.host.list(facts.sessionId), facts.sessionId)
      } catch (error) {
        return { kind: 'error', text: engineMsg('command.rollback.listFailed', { detail: errorText(error) }) }
      }
    }
    try {
      const execution: RollbackRewindExecution = {
        id: parsed.id,
        ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
      }
      return renderRewindResult(await deps.host.rewind(execution), parsed.id)
    } catch (error) {
      if (error instanceof EnvironmentLockUnavailableError) {
        return {
          kind: 'error',
          text: engineMsg('command.rollback.mutationLocked', { reason: error.reason, id: parsed.id }),
        }
      }
      return {
        kind: 'error',
        text: engineMsg('command.rollback.rewindFailed', { id: parsed.id, code: 'exception', detail: errorText(error) }),
      }
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ 注册 */

/** 注册所需的依赖面（命令服务惰取回调 + 宿主日志 + 命令依赖）。 */
export interface RollbackCommandRegistrationOptions {
  /** 惰取命令服务：实现必须是「调用期」的 ctx.get('commands')（绝不属性访问、绝不进 inject）。 */
  readonly readCommands: CommandServiceReader
  readonly deps: RollbackCommandDeps
  /** 只 warn：注册失败/服务缺失不得影响其它装配。 */
  readonly log?: { warn(message: string, meta?: unknown): void }
}

/**
 * 注册 /rollback 与 /rw（两条定义 = 同一 definitionId）。
 *
 * 服务缺失 → warn 后**安静返回**（未组合 commands 的部署照常启动、不抛错）；
 * 服务存在但 register 抛错 → warn（其余装配不受影响）。
 * @returns 反注册函数（重复调用安全）。
 */
export function registerRollbackCommand(options: RollbackCommandRegistrationOptions): () => void {
  const disposers: (() => void)[] = []
  let service: CommandServiceLike | undefined
  try {
    service = options.readCommands() ?? undefined
  } catch (error) {
    options.log?.warn(engineMsg('command.rollback.serviceUnavailable', { detail: errorText(error) }))
    return () => {}
  }
  if (service === undefined || typeof service.register !== 'function') {
    options.log?.warn(engineMsg('command.rollback.serviceUnavailable', { detail: 'commands-service-missing' }))
    return () => {}
  }
  const handler = makeRollbackCommandHandler(options.deps)
  const definitions: readonly CommandDefinitionLike[] = [
    {
      name: ROLLBACK_COMMAND_NAME,
      definitionId: ROLLBACK_COMMAND_DEFINITION_ID,
      description: engineMsg('command.rollback.commandDesc'),
      input: { hint: engineMsg('command.rollback.commandInputHint') },
      handler,
    },
    {
      name: ROLLBACK_COMMAND_ALIAS,
      definitionId: ROLLBACK_COMMAND_DEFINITION_ID,
      description: engineMsg('command.rollback.commandDescAlias'),
      input: { hint: engineMsg('command.rollback.commandInputHint') },
      handler,
    },
  ]
  for (const definition of definitions) {
    try {
      const disposer = service.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    } catch (error) {
      options.log?.warn(engineMsg('command.rollback.registerFailed', { name: definition.name, detail: errorText(error) }))
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        options.log?.warn(engineMsg('command.rollback.registerFailed', { name: 'dispose', detail: errorText(error) }))
      }
    }
  }
}
