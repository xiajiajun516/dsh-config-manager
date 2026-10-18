/**
 * 外部 agent 导入的**展示模型**（t17）—— 框架无关纯函数，node 可测。
 *
 * 数据来源两个（都只读）：
 *  - `GET /foreign-sources`：各来源的本机检测结果（found / 相对位置 / 机器码）；
 *  - 交付给向导前的「将导入什么」摘要（分区 + 计数 + 凭据引用名 + 未迁移项）。
 *
 * 本模块只做四件事，全部可单测：
 *  ① 检测结果 → 可渲染的来源行（显示名 / 状态徽章语义 / 命中路径 / 未迁移码）；
 *  ② 摘要 → 计数徽章与分区清单；
 *  ③ **机器码 → 字典键**的唯一映射（界面据此渲染人话）；
 *  ④ **三类已知有损**的展示行（F-5：只让它们可见，不改任何引擎语义）；
 *  ⑤ **展示顺序**（命中优先 + 显示名升序 —— 用户 2026-10-12 要求的「默认按名称排序」）。
 *
 * 三条纪律（都有单测钉住）：
 *  ① **禁止渲染裸机器码**：每个 skip 码必须经 SKIP_KEY 映射到字典键；映射表是
 *     `Record<ForeignSkipCode, …>`（不是 Partial），新增码而忘了配文案 = 编译失败，
 *     而不是用户界面上冒出一个 session-id-conflict。
 *  ② **未知来源不编造**：id 不在来源词表时显示「未识别的来源」并保留原始 id，
 *     绝不硬套某个来源的名字（那会让用户以为导的是 A、实际是 B）。
 *  ③ **未检测到 ≠ 错误**：found=false 是正常状态（未安装），用中性徽章；
 *     只有 skipped 里真有码时才升到警示色。
 *
 * 本模块**不含任何文案字面量**：所有用户可见文本来自注入的 `UiT`（src/ui/i18n.ts）。
 */
import type { ForeignSkip, ForeignSkipCode, ForeignSourceId } from '../foreign/types.ts'
// 「文件类分区」的判定只取注册表这一份权威（t29）——不得在这里另抄一份分区清单
// （section-registry 是零依赖模块，client bundle 侧的 ui/export-flow.ts 已在用）。
import { isFileSection, isSectionId } from '../schema/section-registry.ts'
import type { UiT, UiTextKey } from './i18n.ts'

/* ------------------------------------------------------------------ 输入 */

/** `GET /foreign-sources` 返回的一条来源检测结果（与宿主 ForeignSourceStatus 同构） */
export interface ForeignSourceStatusInput {
  id: string
  /** 宿主给的字典键（如 foreign.source.claude-code）；**只作为兜底**，正常走 id 映射 */
  labelKey?: string
  found: boolean
  /** 命中位置（相对 home 的 POSIX 路径；宿主保证绝不是绝对路径） */
  paths: readonly string[]
  skipped?: readonly ForeignSkip[]
}

/** `GET /foreign-sources` 响应 */
export interface ForeignSourcesResponse {
  conflictPolicy?: string
  projectScoped?: boolean
  sources: readonly ForeignSourceStatusInput[]
}

/* ------------------------------------------------------------------ 输出 */

/** 一条未迁移项（码 + 人话 + 来源/条数） */
export interface ForeignSkipLine {
  code: string
  /** 字典键（'foreign.skip.' + code） */
  key: UiTextKey
  /** 已翻译说明 */
  text: string
  /** 外部侧位置（server 名 / skill 名 / 文件名；不含任何值） */
  origin?: string
  /** 同码聚合条数 */
  count?: number
}

/** 徽章语义（与 common/ui.tsx 的 BadgeKind 一一对应；本层不 import 组件） */
export type ForeignBadgeKind = 'ok' | 'info' | 'warn' | 'error'

/** 一条来源的展示行 */
export interface ForeignSourceRow {
  id: string
  /** 显示名（已翻译；未知 id → 「未识别的来源」+ 保留原始 id） */
  label: string
  found: boolean
  /** 本机是否认得这个 id（false = 宿主回了词表外的 id，界面如实标注） */
  known: boolean
  /** 状态徽章语义：未检测到 = info（正常），检测到 = ok，有未迁移项 = warn */
  badge: ForeignBadgeKind
  /** 状态徽章文本（已翻译） */
  statusText: string
  /** 命中位置（原样透传；渲染层逐个显示） */
  paths: readonly string[]
  /** 未迁移项（已翻译） */
  skips: readonly ForeignSkipLine[]
  /** true = 本机检测到该来源但**一个可导入分区都没有**（界面据此禁用「导入」） */
  empty: boolean
}

/** 整个来源列表的展示模型 */
export interface ForeignSourcesViewModel {
  rows: readonly ForeignSourceRow[]
  /** 至少有一条 found=true（界面据此决定是否提示「未检测到任何来源」） */
  anyFound: boolean
  /** 冲突策略（用户决策：同 id 不覆盖、跳过并报码）；宿主未回 = null，界面不渲染该行 */
  conflictPolicy: string | null
}

/* ------------------------------------------------------------------ 码 → 字典键 */

/**
 * 未迁移机器码 → 字典键（**全量**，不是 Partial）。
 *
 * 为什么用 `Record<ForeignSkipCode, UiTextKey>` 而不是 `Record<string, UiTextKey>`：
 * src/foreign/types.ts 的 ForeignSkipCode 是**冻结 union**，用全量 Record 让「新增码但忘了
 * 配文案」变成**编译期错误**。t16 已把冻结码的 zh/en 文案都写进两本字典（档 B 新增两条
 * 同步补上），这里只是索引。
 */
export const FOREIGN_SKIP_KEY: Record<ForeignSkipCode, UiTextKey> = {
  'unsupported-hooks': 'foreign.skip.unsupported-hooks',
  'unsupported-commands': 'foreign.skip.unsupported-commands',
  'credentials-not-migrated': 'foreign.skip.credentials-not-migrated',
  'skill-missing-file': 'foreign.skip.skill-missing-file',
  'skill-invalid-frontmatter': 'foreign.skip.skill-invalid-frontmatter',
  'skill-invalid-name': 'foreign.skip.skill-invalid-name',
  'mcp-server-empty': 'foreign.skip.mcp-server-empty',
  'mcp-type-sse-coerced': 'foreign.skip.mcp-type-sse-coerced',
  'mcp-credential-redacted': 'foreign.skip.mcp-credential-redacted',
  'source-unreadable': 'foreign.skip.source-unreadable',
  'session-format-version-unknown': 'foreign.skip.session-format-version-unknown',
  'session-format-unsupported': 'foreign.skip.session-format-unsupported',
  'session-missing-cwd': 'foreign.skip.session-missing-cwd',
  'session-unsafe-id': 'foreign.skip.session-unsafe-id',
  'session-empty': 'foreign.skip.session-empty',
  'session-unparsable': 'foreign.skip.session-unparsable',
  'unsupported-session-record': 'foreign.skip.unsupported-session-record',
  'session-id-conflict': 'foreign.skip.session-id-conflict',
  'skill-id-conflict': 'foreign.skip.skill-id-conflict',
  'sessions-not-migrated': 'foreign.skip.sessions-not-migrated',
  'memory-report-only': 'foreign.skip.memory-report-only',
  'skill-category-flattened': 'foreign.skip.skill-category-flattened',
  'legacy-rules-file': 'foreign.skip.legacy-rules-file',
  'instructions-merged': 'foreign.skip.instructions-merged',
  'instructions-override-selected': 'foreign.skip.instructions-override-selected',
  'source-empty-file': 'foreign.skip.source-empty-file',
  'source-location-overridden': 'foreign.skip.source-location-overridden',
  // 档 B（t6）新增两条：把「推导出的 cwd」与「没有自动根」也变成可见事实，绝不静默
  'session-cwd-derived': 'foreign.skip.session-cwd-derived',
  'source-needs-explicit-path': 'foreign.skip.source-needs-explicit-path',
  // 2026-10-18（8 个新冻结码）：Claude Code 项目级 / 插件 / 权限 / 设置键诊断 + 会话 id 不一致 +
  // MCP 同名 + 项目扫描触顶 —— 仍用全量 Record 兜住：新增码而没配文案 = 编译失败。
  'unsupported-permissions': 'foreign.skip.unsupported-permissions',
  'unsupported-settings-keys': 'foreign.skip.unsupported-settings-keys',
  'unsupported-agents': 'foreign.skip.unsupported-agents',
  'unsupported-rules': 'foreign.skip.unsupported-rules',
  'unsupported-plugins': 'foreign.skip.unsupported-plugins',
  'session-id-mismatch': 'foreign.skip.session-id-mismatch',
  'mcp-server-id-conflict': 'foreign.skip.mcp-server-id-conflict',
  'project-scan-truncated': 'foreign.skip.project-scan-truncated',
}

/**
 * 机器码 → 字典键。**未知码（未来版本 / 第三方宿主）回退键名本身**，
 * 界面仍显示原始码 —— 这比编一个解释诚实（用户可据此搜索/上报）。
 *
 * 注意：本函数返回**键**而不是文案，翻译由调用方注入的 `t` 完成 ——
 * 视图模型不持有字典，测试才能逐键断言。
 */
export function foreignSkipKey(code: string): string {
  return 'foreign.skip.' + code
}

/**
 * 来源 id → 显示名字典键。**全量覆盖 `ForeignSourceId` union**（配置类 6 + 会话类 24；
 * `registry.ts` 的 `FOREIGN_SOURCE_IDS` 当前只列配置类，词表收敛见 `source-modules.ts`）——
 * 全量 Record 让「新增来源但忘了配文案」变成编译期错误；不在词表内 → null（调用方走
 * 「未识别的来源」，绝不硬套某个来源的名字）。
 */
const SOURCE_LABEL_KEY: Record<ForeignSourceId, UiTextKey> = {
  'claude-code': 'foreign.source.claude-code',
  hermes: 'foreign.source.hermes',
  cursor: 'foreign.source.cursor',
  codex: 'foreign.source.codex',
  copilot: 'foreign.source.copilot',
  antigravity: 'foreign.source.antigravity',
  // 会话类（档 B 一次补齐 dsh-chat-import 的 FORMATS 清单；顺序 = types.ts 的 ForeignSourceId union）
  gemini: 'foreign.source.gemini',
  reasonix: 'foreign.source.reasonix',
  opencode: 'foreign.source.opencode',
  mimocode: 'foreign.source.mimocode',
  zcode: 'foreign.source.zcode',
  grokbuild: 'foreign.source.grokbuild',
  openclaw: 'foreign.source.openclaw',
  pi: 'foreign.source.pi',
  kimi: 'foreign.source.kimi',
  kilocode: 'foreign.source.kilocode',
  qoder: 'foreign.source.qoder',
  chatgpt: 'foreign.source.chatgpt',
  workbuddy: 'foreign.source.workbuddy',
  qwen: 'foreign.source.qwen',
  continue: 'foreign.source.continue',
  cline: 'foreign.source.cline',
  goose: 'foreign.source.goose',
  dsh4: 'foreign.source.dsh4',
  zed: 'foreign.source.zed',
  crush: 'foreign.source.crush',
  teleagent: 'foreign.source.teleagent',
  trae: 'foreign.source.trae',
  vibe: 'foreign.source.vibe',
  dsh: 'foreign.source.dsh',
}

/** 来源 id 是否在本插件的冻结词表内。 */
export function isKnownForeignSource(id: string): id is ForeignSourceId {
  return Object.prototype.hasOwnProperty.call(SOURCE_LABEL_KEY, id)
}

/* ------------------------------------------------------------------ 行构造 */

/** 单条 skip → 可渲染行（码 + 已翻译说明 + 来源/条数） */
export function foreignSkipLine(skip: ForeignSkip, t: UiT): ForeignSkipLine {
  const key = foreignSkipKey(skip.code)
  const line: ForeignSkipLine = {
    code: skip.code,
    // 已知码走冻结映射（类型层保证键存在）；未知码回退 'foreign.skip.<code>'，
    // UiT 对未注册键**原样返回键名**（见 src/ui/i18n.ts 的 makeUiT），因此界面
    // 不会显示 undefined，而是显示一个可搜索的稳定标识。
    key: (isKnownSkipCode(skip.code) ? FOREIGN_SKIP_KEY[skip.code] : key) as UiTextKey,
    text: t((isKnownSkipCode(skip.code) ? FOREIGN_SKIP_KEY[skip.code] : key) as UiTextKey),
  }
  if (skip.origin !== undefined && skip.origin !== '') line.origin = skip.origin
  if (skip.count !== undefined && skip.count > 0) line.count = skip.count
  return line
}

/** 码是否在冻结词表内（运行期判定；类型层用 FOREIGN_SKIP_KEY 全量 Record 兜住新增） */
function isKnownSkipCode(code: string): code is ForeignSkipCode {
  return Object.prototype.hasOwnProperty.call(FOREIGN_SKIP_KEY, code)
}

/**
 * 检测结果 → 一行来源。
 *
 * 徽章语义三分（**未检测到不是错误**，这条最容易被写成红色）：
 *  · found=false            → info（正常状态：没装这个工具）
 *  · found=true  且 有 skip → warn（能导，但有东西没搬过来，用户需要知道）
 *  · found=true  且 无 skip → ok
 *
 * `empty` = found 但**一条路径都没命中**（宿主理论上不会这么回，但第三方实现可能）——
 * 界面据此禁用「导入」，避免用户点进一个必然空手的流程。
 */
export function foreignSourceRow(source: ForeignSourceStatusInput, t: UiT): ForeignSourceRow {
  // 直接对 id 做类型守卫（不先存 boolean 变量）：`const known = isKnown(…) ` 之后
  // tsc 不会跨该布尔变量窄化 source.id，索引 Record<ForeignSourceId, …> 会报 TS7053。
  const knownId = isKnownForeignSource(source.id) ? source.id : null
  const known = knownId !== null
  const label = knownId !== null
    ? t(SOURCE_LABEL_KEY[knownId])
    : t('foreign.source.unknownWithId', { id: source.id })
  const skips = (source.skipped ?? []).map((s) => foreignSkipLine(s, t))
  const paths = [...source.paths]
  const badge: ForeignBadgeKind = !source.found ? 'info' : skips.length > 0 ? 'warn' : 'ok'
  return {
    id: source.id,
    label,
    found: source.found,
    known,
    badge,
    statusText: source.found ? t('foreign.found.yes') : t('foreign.found.no'),
    paths,
    skips,
    // 未检测到时 empty 恒 false：真正的空是「装了但读不到任何东西」，与「没装」是两回事
    empty: source.found && paths.length === 0,
  }
}

/** 命中位置的一行文本（无命中时给明确的「没有命中」而不是空白）。 */
export function foreignPathsText(row: ForeignSourceRow, t: UiT): string {
  if (row.paths.length === 0) return t('foreign.pathsNone')
  return t('foreign.paths', { paths: row.paths.join(' · ') })
}

/* ------------------------------------------------------------------ 展示顺序 */

/**
 * 显示名排序器：大小写不敏感（`base`）、数字按数值（`Foo 2` 在 `Foo 10` 之前）。
 * 词典序按**运行环境的默认语言**解析 —— 用户看到的就是他母语的字母/拼音序；
 * 同名的两条保持宿主回传的相对顺序（`Array#sort` 稳定）。
 */
const ROW_LABEL_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * 两条来源行的展示顺序（**界面唯一权威**，两处判据只有这一份）：
 *  ① **命中的在前**（`found` 降序）—— 装了却没排在最上面，用户得先读完一屏「未检测到」；
 *  ② 同组内按**显示名**升序。
 *
 * 为什么按显示名而不是 id：列表上用户读到的是 label（`Google Antigravity`），
 * 按 id 排会把它顶到 A 开头，与眼睛看到的字母序不符（`copilot` → 「GitHub Copilot CLI」同理）。
 * 这条规则对「全未命中」自然退化为**纯名称序**，也就是用户要的「默认按名称排序」。
 */
function compareForeignSourceRows(a: ForeignSourceRow, b: ForeignSourceRow): number {
  if (a.found !== b.found) return a.found ? -1 : 1
  return ROW_LABEL_COLLATOR.compare(a.label, b.label)
}

/**
 * 响应 → 整表展示模型（组件只摆放）。
 *
 * `?projectDir=` 的项目级作用域如实透传（`projectScoped`）—— 界面把它显示出来，
 * 否则用户会以为「本机没装 Cursor」而实际上是「项目级配置没被扫」。
 *
 * 行顺序由 compareForeignSourceRows 决定（命中优先 + 显示名升序），**只排新数组**：
 * 宿主回传的 `response.sources` 一个元素都不动。
 */
export function foreignSourcesViewModel(
  response: ForeignSourcesResponse | null,
  t: UiT,
): ForeignSourcesViewModel | null {
  if (response === null) return null
  const rows = response.sources.map((s) => foreignSourceRow(s, t)).sort(compareForeignSourceRows)
  return {
    rows,
    anyFound: rows.some((r) => r.found),
    conflictPolicy: response.conflictPolicy !== undefined && response.conflictPolicy !== ''
      ? response.conflictPolicy
      : null,
  }
}

/* ------------------------------------------------------------ 已知有损（F-5） */

/**
 * 三类**已知有损**的稳定标识（与字典键一一对应；新增一项必须同步 zh/en 两本字典）。
 *
 * 为什么要有这一层：这三条都是「**不阻断导入、但结果与用户预期不同**」的既有行为，
 * 此前在界面上没有任何入口说明它们（兼容性评分也不产出原因）。本层**只做可见性**，
 * 不改动任何引擎语义（分区内容、ZIP 条目名规则、prompts 落盘形态全部原样）。
 */
export type ForeignLossyKind = 'file-section-secrets' | 'entry-backslash' | 'prompt-persona-reshape'

/** 有损项的严重级（warn = 内容或落点确实不同；info = 形状变化、文本无损） */
export type ForeignLossySeverity = 'warn' | 'info'

/** 一条「已知有损」的展示行（标题与说明均已翻译） */
export interface ForeignLossyRow {
  kind: ForeignLossyKind
  severity: ForeignLossySeverity
  /** 短标题（已翻译） */
  title: string
  /** 说明（已翻译） */
  detail: string
  /**
   * 本包是否适用：
   *  · `true` / `false`：**已产包**，按包内分区判定；
   *  · `null`：**尚未产包**，界面不渲染适用性徽章 —— 绝不把「还没判定」写成「不适用」。
   */
  applicable: boolean | null
}

const LOSSY_TITLE_KEY: Record<ForeignLossyKind, UiTextKey> = {
  'file-section-secrets': 'foreign.lossy.file-section-secrets.title',
  'entry-backslash': 'foreign.lossy.entry-backslash.title',
  'prompt-persona-reshape': 'foreign.lossy.prompt-persona-reshape.title',
}

const LOSSY_DETAIL_KEY: Record<ForeignLossyKind, UiTextKey> = {
  'file-section-secrets': 'foreign.lossy.file-section-secrets.detail',
  'entry-backslash': 'foreign.lossy.entry-backslash.detail',
  'prompt-persona-reshape': 'foreign.lossy.prompt-persona-reshape.detail',
}

const LOSSY_SEVERITY: Record<ForeignLossyKind, ForeignLossySeverity> = {
  'file-section-secrets': 'warn',
  'entry-backslash': 'warn',
  'prompt-persona-reshape': 'info',
}

/** 渲染顺序（固定，不随调用方漂移） */
export const FOREIGN_LOSSY_KINDS: readonly ForeignLossyKind[] = [
  'file-section-secrets',
  'entry-backslash',
  'prompt-persona-reshape',
]

/**
 * 三类有损 → 可渲染行（组件只摆放）。
 *
 * `sections` = 刚产出的包内分区（`ForeignImportResponse.sections`），尚未产包时传 `null`：
 *  · **文件类分区**（`isFileSection`，注册表是唯一权威）→ 内容不做秘密剥离（G-09 边界）；
 *  · **条目名中段反斜杠**（G-11）→ 浏览器只看得到分区与计数、看不到条目名，因此只要产了包
 *    就**如实提示**（宁可多说一句，也不谎称「本包不涉及」）；
 *  · **`prompts` 分区** → `systemPrompt` 由字符串写成 `{ persona }` 对象（bundle-format §7.3）。
 */
export function foreignLossyRows(sections: readonly string[] | null, t: UiT): readonly ForeignLossyRow[] {
  const hasFileSection = sections !== null && sections.some((id) => isSectionId(id) && isFileSection(id))
  const hasPrompts = sections !== null && sections.indexOf('prompts') >= 0
  const applicable: Record<ForeignLossyKind, boolean | null> = {
    'file-section-secrets': sections === null ? null : hasFileSection,
    'entry-backslash': sections === null ? null : true,
    'prompt-persona-reshape': sections === null ? null : hasPrompts,
  }
  return FOREIGN_LOSSY_KINDS.map((kind) => ({
    kind,
    severity: LOSSY_SEVERITY[kind],
    title: t(LOSSY_TITLE_KEY[kind]),
    detail: t(LOSSY_DETAIL_KEY[kind]),
    applicable: applicable[kind],
  }))
}
