/**
 * 同步设置面板的**框架无关纯逻辑**（t42：从 src/client/sync/SyncSettingsView.tsx 下沉）。
 *
 * 分层约定（AGENTS.md「逻辑放 src/ui/」）：
 * - 本模块**不 import src/client/**（避免 ui → client 反向依赖，也让 node 可直接测）；
 * - 入参用**结构类型**：client 侧的 `SyncPushPayload` / `ChannelSyncState` / `SyncStatusResponse`
 *   与这里的结构同形，可直接传入（类型变了会在 typecheck 阶段报出来，不会静默漂移）；
 * - 只放「状态机 / 派生计算 / 请求体组装 / 格式化」四类可测逻辑，**不放 React**。
 *
 * 组件（SyncSettingsView.tsx）保留：React 状态、useRef 定时器、网络调用与 JSX 装配。
 */
import type { SectionId } from '../schema/types.ts'
import type { Selection } from './selection-model.ts'

/* ---------------------------------------------------------------- 基础类型 */

/** 通道名（git | webdav）。 */
export type SyncChannelName = 'git' | 'webdav'

/** 自动同步间隔（与 client 的 AutosyncInterval 同形）。 */
export type SyncAutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h'

/** 表单快照（组件 state 里与本模块相关的那部分）。 */
export interface SyncFormSnapshot {
  channel: SyncChannelName
  repoUrl: string
  /** 仅内存；成功后由组件清空（已写入 DSH credentials） */
  token: string
  webdavUrl: string
  webdavUsername: string
  /** 仅内存；成功后由组件清空 */
  webdavPassword: string
}

/** 当前通道的设置快照（组件 state.byChannel[channel] 中与本模块相关的那部分）。 */
export interface SyncChannelSettings {
  syncSections: readonly SectionId[]
  sessionsLimit: number
  /**
   * 显式点名的会话单元 id（非空时优先于 sessionsLimit；空 = 「最新 N 个」模式）。
   * 与导出选择器的单元 id 同命名空间（sessions:<projectKey>/<sessionId>）。
   */
  sessionsInclude: readonly string[]
  encrypt: boolean
  includeSecrets: boolean
  encryptPassword: string
  encryptPasswordConfirm: string
  /** 本机凭据库里是否已有密码（只回布尔，值永不回浏览器） */
  encryptPasswordSaved: boolean
  decryptPassword: string
}

/** 推/拉请求体（与 client 的 SyncPushPayload / SyncPullPayload 同形）。 */
export interface SyncPushBody {
  transport?: SyncChannelName
  repoUrl?: string
  token?: string
  url?: string
  username?: string
  password?: string
  sections?: SectionId[]
  /**
   * sessions（可选分区）选项：**只有显式提供它**，会话才被允许进入同步通道
   * （Host 侧安全默认：未提供则按非 portable 分区跳过）。绝不悄悄携带。
   */
  sessions?: { limit?: number; include?: string[] }
  encrypt?: boolean
  encryptPassword?: string
  includeSecrets?: boolean
}

/** 同步分区选择请求体（与 client 的 SyncSelectionPayload 同形；响应回填字段不在此列）。 */
export interface SyncSelectionRequestBody {
  transport: SyncChannelName
  mode: 'advanced'
  sections: SectionId[]
  sessionsLimit: number
  sessionsInclude: string[]
  encrypt: boolean
  includeSecrets: boolean
  encryptPassword?: string
  decryptPassword?: string
  clearEncryptPassword?: boolean
  clearDecryptPassword?: boolean
}

/** 分区选择的部分更新（与组件内 SelectionPatch 同形）。 */
export interface SyncSelectionPatch {
  sections?: SectionId[]
  sessionsLimit?: number
  sessionsInclude?: string[]
  encrypt?: boolean
  includeSecrets?: boolean
  encryptPassword?: string
  decryptPassword?: string
  clearEncryptPassword?: boolean
  clearDecryptPassword?: boolean
}

/** 组件 state 的通道补丁（Partial<ChannelSyncState> 的可用子集）。 */
export interface SyncChannelSettingsPatch {
  syncSections?: SectionId[]
  sessionsLimit?: number
  sessionsInclude?: string[]
  encrypt?: boolean
  includeSecrets?: boolean
  encryptPassword?: string
  encryptPasswordConfirm?: string
  encryptPasswordSaved?: boolean
  decryptPassword?: string
  decryptPasswordSaved?: boolean
}

/** 从 /sync/status 回填到单个通道的字段（与 ChannelSyncState 的这些字段同形）。 */
export interface SyncChannelBackfill {
  syncMode: 'advanced'
  syncSections: SectionId[]
  sessionsLimit: number
  sessionsInclude: string[]
  encrypt: boolean
  includeSecrets: boolean
  encryptPasswordSaved: boolean
  decryptPasswordSaved: boolean
  autosyncEnabled: boolean
  autosyncInterval: SyncAutosyncInterval
}

/** 按通道的持久化选择（/sync/status 的 syncSelectionByChannel[ch]）。 */
export interface SyncSelectionLike {
  sessionsLimit?: number
  sessionsInclude?: string[]
  encrypt?: boolean
  includeSecrets?: boolean
}

/** 按通道的自动同步状态（/sync/status 的 autosyncByChannel[ch]）。 */
export interface SyncAutosyncLike {
  enabled: boolean
  interval: SyncAutosyncInterval
}

/** 按通道的凭据状态（/sync/status 的 syncCredentialsByChannel[ch]；只回布尔）。 */
export interface SyncCredentialsLike {
  encryptPasswordConfigured?: boolean
  decryptPasswordConfigured?: boolean
}

/** GitHub device flow 轮询响应里本模块关心的字段。 */
export interface GithubPollLike {
  status: 'pending' | 'success' | 'denied' | 'expired' | 'error'
  /** 服务端建议的下次轮询间隔（ms）；缺省用 interval 兜底 */
  pollDelayMs?: number
}

/** GitHub device flow 轮询的下一步决策（组件据此 patch 状态 / 排下一次定时器）。 */
export interface GithubPollDecision {
  /** 下一步相位（pending → waiting；success → success；其余终止态 → error） */
  phase: 'waiting' | 'success' | 'error'
  /** pending 时下一次轮询的延迟（ms）；非 pending 为 null（不再排期） */
  delayMs: number | null
}

/* ---------------------------------------------------------------- 常量 */

/** 表单改动 → 自动保存的防抖时长（ms）。 */
export const SYNC_CONFIG_SAVE_DEBOUNCE_MS = 600

/* ------------------------------------------------------------ 请求体组装 */

/**
 * 组装通道鉴权字段（git：repoUrl/token；webdav：url/username/password；扁平顶层）。
 *
 * `trimToken` 是搬家前就存在的**既有差异**，本次只做搬迁、保持行为完全一致：
 * - push / 一键同步 路径沿用输入原值（不 trim）；
 * - 「保存配置」路径对 token 做 trim。
 * 用显式参数把差异固定下来，避免以后有人「顺手统一」而改变行为。
 */
function channelAuthBody(form: SyncFormSnapshot, opts: { trimToken: boolean }): SyncPushBody {
  if (form.channel === 'webdav') {
    const url = form.webdavUrl.trim()
    return {
      transport: 'webdav',
      url: url !== '' ? url : undefined,
      username: form.webdavUsername.trim() !== '' ? form.webdavUsername.trim() : undefined,
      password: form.webdavPassword !== '' ? form.webdavPassword : undefined,
    }
  }
  return {
    transport: 'git',
    repoUrl: form.repoUrl.trim(),
    token: form.token.trim() !== '' ? (opts.trimToken ? form.token.trim() : form.token) : undefined,
  }
}

/** push / pull / 一键同步的公共请求体（仅通道鉴权字段；空串不携带，密码仅内存）。 */
export function buildSyncChannelBody(form: SyncFormSnapshot): SyncPushBody {
  return channelAuthBody(form, { trimToken: false })
}

/** 「保存配置」请求体：当前通道远端地址未就绪（webdav url / git repoUrl 为空）→ null（自动保存跳过）。 */
export function buildSyncConfigBody(form: SyncFormSnapshot): SyncPushBody | null {
  if (form.channel === 'webdav' && form.webdavUrl.trim() === '') return null
  if (form.channel === 'git' && form.repoUrl.trim() === '') return null
  return channelAuthBody(form, { trimToken: true })
}

/**
 * push / 预览的完整请求体 = 通道鉴权 + 分区选择 + 加密选项。安全不变量：
 * - **sessions 必须显式放行**：只有勾选了 sessions 才携带 `sessions`（否则会话绝不随同步上行）；
 * - **includeSecrets ⇒ encrypt**：勾了「导出密钥」即使没勾加密，也强制 `encrypt: true`（密钥绝不明文上行）。
 */
export function buildSyncPushBody(form: SyncFormSnapshot, settings: SyncChannelSettings): SyncPushBody {
  const sections = [...settings.syncSections]
  const selection = sections.length > 0 ? { sections } : {}
  // 显式点名（include）优先于数量上限（limit）：非空时只带用户勾中的对话
  const sessionsOpt = sections.includes('sessions')
    ? {
        sessions: {
          limit: settings.sessionsLimit,
          ...(settings.sessionsInclude.length > 0 ? { include: [...settings.sessionsInclude] } : {}),
        },
      }
    : {}
  const cryptoOpts =
    settings.encrypt || settings.includeSecrets
      ? { encrypt: true, encryptPassword: settings.encryptPassword, includeSecrets: settings.includeSecrets }
      : {}
  return { ...buildSyncChannelBody(form), ...selection, ...sessionsOpt, ...cryptoOpts }
}

/**
 * 同步分区选择请求体（POST /sync/selection）。既有语义：
 * - mode 恒 `advanced`（勾选集合就是同步范围，UI 已无模式概念）；
 * - 未给出的字段沿用当前通道既有值；
 * - 密码字段：**非空才携带**（空 = 沿用本机凭据库里已保存的密码）；
 * - `clear*` 删除标记与密码写入可同时出现（Host 侧以删除优先）。
 */
export function buildSelectionRequest(
  channel: SyncChannelName,
  current: SyncChannelSettings,
  patch: SyncSelectionPatch = {},
): SyncSelectionRequestBody {
  return {
    transport: channel,
    mode: 'advanced',
    sections: [...(patch.sections ?? current.syncSections)],
    sessionsLimit: patch.sessionsLimit ?? current.sessionsLimit,
    sessionsInclude: [...(patch.sessionsInclude ?? current.sessionsInclude)],
    encrypt: patch.encrypt ?? current.encrypt,
    includeSecrets: patch.includeSecrets ?? current.includeSecrets,
    ...(patch.encryptPassword !== undefined && patch.encryptPassword !== ''
      ? { encryptPassword: patch.encryptPassword }
      : {}),
    ...(patch.decryptPassword !== undefined && patch.decryptPassword !== ''
      ? { decryptPassword: patch.decryptPassword }
      : {}),
    ...(patch.clearEncryptPassword === true ? { clearEncryptPassword: true } : {}),
    ...(patch.clearDecryptPassword === true ? { clearDecryptPassword: true } : {}),
  }
}

/* ------------------------------------------------------------ 派生计算 */

/** 勾选/取消某个同步分区（不产生重复项；取消时按 id 过滤）。 */
export function toggleSectionSelection(
  current: readonly SectionId[],
  id: SectionId,
  checked: boolean,
): SectionId[] {
  if (!checked) return current.filter((s) => s !== id)
  return current.includes(id) ? [...current] : [...current, id]
}

/** 勾选是否非空（勾选集合就是同步范围 → 空集合禁止推送）。 */
export function hasSelectedSections(settings: Pick<SyncChannelSettings, 'syncSections'>): boolean {
  return settings.syncSections.length > 0
}

/* ------------------------------------------------ 历史会话逐项勾选（P0-3） */

/**
 * 本次勾选是否需要会话单元清单（= 勾了 sessions 才需要）。
 *
 * 为什么是个函数而不是让组件直接判：仓库的结构守卫禁止「sessions 显式放行规则」散落在
 * React 壳里（src/client/sync/SyncSettingsView.test.ts 的 t42 分层守卫），且这条规则
 * 属于业务判断 —— 放在 ui 层可 node 直测，组件只消费结论。
 */
export function needsSessionInventory(sections: readonly SectionId[]): boolean {
  return sections.includes('sessions')
}

/**
 * 打开会话选择器时的初始勾选：
 * - 已有显式点名（include 非空）→ 原样返回（绝不覆盖用户的结果）；
 * - 否则取清单**前 N 条**作为「最新 N 个」的可视化预选 —— 清单由宿主按会话最新活动
 *   时间倒序返回（/export-preview 注入 unitActivityTimes），所以前 N 条就是引擎会带走的那几个。
 *
 * 为什么要有这一步：sessionsInclude 为空时引擎按「最新 N 个」筛选，用户看不到是哪几个。
 * 预选把它们显式呈现出来，从「数量」平滑过渡到「点名」，也让「不勾任何 = 回到最新 N 个」
 * 这条回退语义有据可依。
 */
export function initialSessionPicks(
  unitIds: readonly string[],
  include: readonly string[],
  limit: number,
): string[] {
  if (include.length > 0) return [...include]
  return unitIds.slice(0, Math.max(limit, 0))
}

/** sessionsInclude（白名单）→ ContentPicker 的 Selection（excluded = 清单里没被点名的那些）。 */
export function sessionPickerSelection(unitIds: readonly string[], picks: readonly string[]): Selection {
  const set = new Set(picks)
  return { sections: ['sessions'], excluded: unitIds.filter((id) => !set.has(id)) }
}

/**
 * ContentPicker 的 Selection → sessionsInclude（按清单顺序，结果稳定可复现）。
 *
 * 绕开 buildExportRequest 的「整分区全选 = 不下发白名单」压缩：同步侧的 include 空数组
 * 有**独立语义**（= 回到「最新 N 个」），不能被“全选”悄悄吞掉。
 */
export function pickedSessionIds(sel: Selection, unitIds: readonly string[]): string[] {
  if (!sel.sections.includes('sessions')) return []
  return unitIds.filter((id) => !sel.excluded.includes(id))
}

/**
 * 「加密备份」开关的联动（既有语义，搬家不改）：
 * - 打开：只改 encrypt（密钥导出的勾选保持用户原样）；
 * - 关闭：一并取消「导出密钥」、清空两个密码输入框、复位「已保存」标记，并**删除本机凭据库里保存的加密密码**
 *   （用户主动取消勾选即清除保存的密码，密钥绝不明文进同步通道）。
 */
export function encryptToggle(
  next: boolean,
  settings: SyncChannelSettings,
): { channelPatch: SyncChannelSettingsPatch; selectionPatch: SyncSelectionPatch } {
  const includeSecrets = next ? settings.includeSecrets : false
  return {
    channelPatch: {
      encrypt: next,
      includeSecrets,
      ...(next ? {} : { encryptPassword: '', encryptPasswordConfirm: '', encryptPasswordSaved: false }),
    },
    selectionPatch: {
      encrypt: next,
      includeSecrets,
      ...(next ? {} : { clearEncryptPassword: true }),
    },
  }
}

/** 「导出密钥」开关的联动：勾选时自动打开加密（密钥绝不明文进同步通道）。 */
export function includeSecretsToggle(
  next: boolean,
  settings: SyncChannelSettings,
): { channelPatch: SyncChannelSettingsPatch; selectionPatch: SyncSelectionPatch } {
  const encrypt = next ? true : settings.encrypt
  return {
    channelPatch: { includeSecrets: next, encrypt },
    selectionPatch: { includeSecrets: next, encrypt },
  }
}

/**
 * 加密推送校验（加密/导出密钥已勾选时）：
 * - 输入框填了 → 必须与确认框一致（半截密码不算数）；
 * - 输入框留空 → 必须本机凭据库里已有密码（留空即沿用）。
 */
export function computeEncryptInvalid(settings: SyncChannelSettings): boolean {
  if (!settings.encrypt && !settings.includeSecrets) return false
  if (settings.encryptPassword !== '') return settings.encryptPassword !== settings.encryptPasswordConfirm
  return !settings.encryptPasswordSaved
}

/** GitHub device flow 是否进行中（请求设备码 / 等待授权 / 轮询）：进行中禁用 push/pull。 */
export function isGithubFlowInFlight(phase: string): boolean {
  return phase === 'starting' || phase === 'waiting' || phase === 'polling'
}

/**
 * GitHub 轮询的下一步决策：pending → 继续等待并按服务端建议（缺省 interval，最小 1 秒）排期；
 * success → 成功（组件刷新状态）；其余终止态（denied/expired/error）→ 错误态、不再排期。
 */
export function githubPollDecision(poll: GithubPollLike, fallbackIntervalSec: number): GithubPollDecision {
  if (poll.status === 'pending') {
    const delayMs = poll.pollDelayMs ?? Math.max(fallbackIntervalSec, 1) * 1000
    return { phase: 'waiting', delayMs }
  }
  return { phase: poll.status === 'success' ? 'success' : 'error', delayMs: null }
}

/**
 * /sync/status → 单通道设置回填。既有语义：
 * - 模式恒 advanced；
 * - 分区初始值由调用方算好传入（推荐分区规则住在 sync-view.ts 的 initialSyncSections，
 *   本模块不重复实现；用户主动清空 → 传空数组，保持为空，绝不悄悄填回来）；
 * - 密码「已保存」来自本机凭据库，只回布尔；库里没有 → 复位 false。
 */
export function channelBackfillFromStatus(input: {
  selection: SyncSelectionLike | undefined
  autosync: SyncAutosyncLike | undefined
  credentials: SyncCredentialsLike | undefined
  /** 初始勾选：推荐分区规则住在 sync-view.ts 的 initialSyncSections（本模块不重复实现） */
  persistedSections: readonly SectionId[]
  /** 已归一化的 sessions 上限：归一化规则住在 sync-view.ts 的 normalizeSessionsLimit */
  sessionsLimit: number
}): SyncChannelBackfill {
  const { selection, autosync, credentials, persistedSections, sessionsLimit } = input
  return {
    syncMode: 'advanced',
    syncSections: [...persistedSections],
    sessionsLimit,
    sessionsInclude: [...(selection?.sessionsInclude ?? [])],
    encrypt: selection?.encrypt ?? false,
    includeSecrets: selection?.includeSecrets ?? false,
    encryptPasswordSaved: credentials?.encryptPasswordConfigured ?? false,
    decryptPasswordSaved: credentials?.decryptPasswordConfigured ?? false,
    autosyncEnabled: autosync?.enabled ?? false,
    autosyncInterval: autosync?.interval ?? '30m',
  }
}

/* -------------------------------------------------- 配置保存的防重入状态机 */

/** 配置保存的防重入状态（纯数据；组件用 useRef 持有，不用 useState —— 不触发重渲）。 */
export interface SaveQueueState {
  /** 保存请求在途 */
  inFlight: boolean
  /** 在途期间排入的待发改动（`null` = 无待发；地址清空时也会被置 null） */
  pending: SyncPushBody | null
}

/**
 * 一次保存请求的入口决策（对应 doSaveConfig 开头）：
 * - 已在途 → 记下最新待发改动并返回 `'queue'`（防重入，不并发发请求）；
 * - 空闲 → 置在途并返回 `'send'`（待发改动**原样保留**，与原实现一致）。
 */
export function saveQueueOnRequest(
  state: SaveQueueState,
  requested: SyncPushBody | null,
): { state: SaveQueueState; action: 'send' | 'queue' } {
  if (state.inFlight) return { state: { inFlight: true, pending: requested }, action: 'queue' }
  return { state: { inFlight: true, pending: state.pending }, action: 'send' }
}

/**
 * 请求结束（成功/失败都走）后的收敛（对应 finally）：清在途，返回需要在途期间排入的
 * 待发改动（非 null 则由调用方立即补发，保证「保存中又改」的内容不丢）。
 */
export function saveQueueOnSettled(
  state: SaveQueueState,
): { state: SaveQueueState; next: SyncPushBody | null } {
  return { state: { inFlight: false, pending: null }, next: state.pending }
}

/**
 * flush（手动点保存 / 防抖到点）：优先用**待发改动**，否则按当前表单值重建；
 * 无论走哪条都清空待发（一次性消费）。
 */
export function saveQueueOnFlush(
  state: SaveQueueState,
  rebuilt: SyncPushBody | null,
): { state: SaveQueueState; payload: SyncPushBody | null } {
  return { state: { ...state, pending: null }, payload: state.pending ?? rebuilt }
}

/* ------------------------------------------------------------ 格式化 */

/** 自动同步间隔 → i18n 键（组件用 `t(key)` 取文案；未知值返回 null，由调用方原样展示）。 */
export type SyncAutosyncIntervalKey =
  | 'autosync.interval5m' | 'autosync.interval15m' | 'autosync.interval30m' | 'autosync.interval60m'
  | 'autosync.interval6h' | 'autosync.interval12h' | 'autosync.interval24h'

const AUTOSYNC_INTERVAL_LABEL_KEYS: Record<SyncAutosyncInterval, SyncAutosyncIntervalKey> = {
  '5m': 'autosync.interval5m',
  '15m': 'autosync.interval15m',
  '30m': 'autosync.interval30m',
  '60m': 'autosync.interval60m',
  '6h': 'autosync.interval6h',
  '12h': 'autosync.interval12h',
  '24h': 'autosync.interval24h',
}

/** 间隔 → 文案键；未知值 → null（组件保留原样展示，与搬家前的 default 分支一致）。 */
export function autosyncIntervalKey(iv: SyncAutosyncInterval): SyncAutosyncIntervalKey | null {
  return AUTOSYNC_INTERVAL_LABEL_KEYS[iv] ?? null
}

/**
 * 初始通道解析：store 切片缺省 'git'，无法区分「持久化过 git」与「从未持久化」——
 * 无明确记录时回退 localStorage 记住的选择（升级前遗留），避免冲掉用户选择。
 */
export function resolveInitialChannel(
  persistedChannel: SyncChannelName,
  rememberedChannel: SyncChannelName | null,
): SyncChannelName {
  return persistedChannel !== 'git' ? persistedChannel : (rememberedChannel ?? 'git')
}

/**
 * 上次同步时间（ISO 字符串，来自 GET /sync/status 的 lastSyncAt）→ 展示文本。
 *
 * 既有语义原样保留：**只有 undefined** 显示占位符 `—`；空串等异常输入交给
 * `Date` 自己处理（与搬家前的 `new Date(x).toLocaleString()` 完全一致 —— 顺手改成
 * 「空串也显示 —」会改变展示行为，留作独立小项）。
 */
export function formatSyncStatusTimestamp(lastSyncAt: string | undefined, locale?: string): string {
  if (lastSyncAt === undefined) return '—'
  return locale === undefined ? new Date(lastSyncAt).toLocaleString() : new Date(lastSyncAt).toLocaleString(locale)
}

/** 远端地址预览（列表/事实行用）：超长截断到 max 字符（不省略号，保持既有展示）。 */
export function formatSyncUrlPreview(url: string, max = 60): string {
  return url.slice(0, max)
}
