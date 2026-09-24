/**
 * 导入执行日志的解析 / 分组模型（纯函数，node 可测，框架无关）。
 *
 * 为什么要解析：宿主 `RunRegistry.log` 是一串**扁平原始行**，按执行顺序混着三类信息
 * （src/core/analyzer.ts 与 src/adapters/plugins.ts 的 onLog 调用点）：
 *
 *   `▶ <itemId>`  项开始（U+25B6）
 *   `✓/⚠/✗ <itemId>`  项收尾：成功 / 非致命警告 / 失败（U+2713 / U+26A0 / U+2717）
 *   `– <itemId>` / `⏭ <itemId>`  跳过（不写目标 / 用户主动跳过；U+2013 / U+23ED）
 *   `$ dsh plugin … add …`  真实发起的子进程命令行
 *   其它任意文本  该项的补充说明（如「tarball 解包失败，回退原始 spec」）
 *
 * 直接渲染成 500 行流水，用户看不出「哪些项成功、哪些项需要处理」。本模块把同一
 * itemId 的多行**合并成一条记录**（▶ 开、✓/⚠/✗/–/⏭ 收），命令与说明挂成该记录的
 * details，并产出计数（成功 / 跳过 / 警告 / 失败 / 进行中）供表头与筛选使用。
 *
 * 只做解析与聚合，不碰 i18n、不碰 CSS（展示层在 client/import/ImportWizardView.tsx）。
 */

/** 一条计划项在日志里的最终状态（running = 已开始、尚未收尾）。 */
export type ImportLogLevel = 'running' | 'ok' | 'warn' | 'fail' | 'skip'

/** 明细行的种类：command = 真实命令（等宽高亮），text = 说明文本。 */
export type ImportLogDetailKind = 'command' | 'text'

export interface ImportLogDetail {
  kind: ImportLogDetailKind
  text: string
}

/** 一条计划项记录（同 itemId 的多行合并结果）。 */
export interface ImportLogEntry {
  /** React key（行序 + id，稳定且不重复）。 */
  key: string
  /** 计划项 id（如 `plugin:@scope/name`）。 */
  id: string
  level: ImportLogLevel
  details: ImportLogDetail[]
}

export interface ImportLogCounts {
  ok: number
  warn: number
  fail: number
  skip: number
  running: number
}

export interface ImportLogModel {
  /** 按首次出现顺序排列的计划项记录。 */
  entries: ImportLogEntry[]
  /** 不属于任何计划项的散行（罕见；按原样展示在最前）。 */
  loose: ImportLogDetail[]
  counts: ImportLogCounts
  /** 需要用户关注的项数 = 警告 + 失败（跳过是「按预期未写」，不计入）。 */
  problems: number
  /** 已收尾的项数（不含 running）。 */
  finished: number
}

/**
 * 项状态行前缀 → 级别。用码点转义书写：日志里的字形（▶ ✓ ⚠ ✗ – ⏭）在编辑/传输链路上
 * 容易被替换或插入零宽字符，转义写法可避免「字形看起来没变但 startsWith 不命中」。
 */
const ITEM_PREFIXES: readonly (readonly [string, ImportLogLevel])[] = [
  ['\u25b6', 'running'], // ▶
  ['\u2713', 'ok'], // ✓
  ['\u26a0', 'warn'], // ⚠
  ['\u2717', 'fail'], // ✗
  ['\u2013', 'skip'], // – （不写目标的跳过）
  ['\u23ed', 'skip'], // ⏭ （用户主动跳过）
]

/** 子进程命令行前缀（`$ dsh plugin …`）。 */
const COMMAND_PREFIX = '$ '

export type ImportLogParsedLine =
  | { kind: 'item'; level: ImportLogLevel; id: string }
  | { kind: 'detail'; detail: ImportLogDetail }

/** 解析单行：项状态行 → item；其余 → detail（`$ ` 开头记 command）。 */
export function parseImportLogLine(line: string): ImportLogParsedLine {
  const text = line.trimEnd()
  for (const [glyph, level] of ITEM_PREFIXES) {
    if (!text.startsWith(glyph + ' ')) continue
    const id = text.slice(glyph.length + 1).trim()
    if (id !== '') return { kind: 'item', level, id }
  }
  return {
    kind: 'detail',
    detail: { kind: text.startsWith(COMMAND_PREFIX) ? 'command' : 'text', text },
  }
}

/** 把原始日志行聚合成「计划项记录 + 计数」。行序保持（entries 按首次出现顺序）。 */
export function buildImportLogModel(lines: readonly string[]): ImportLogModel {
  const entries: ImportLogEntry[] = []
  const byId = new Map<string, ImportLogEntry>()
  const loose: ImportLogDetail[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseImportLogLine(lines[i] as string)
    if (parsed.kind === 'item') {
      const known = byId.get(parsed.id)
      if (known !== undefined) {
        // 同一项的开始行与收尾行合并：状态以后者为准，明细保留
        known.level = parsed.level
        continue
      }
      const entry: ImportLogEntry = {
        key: i + ':' + parsed.id,
        id: parsed.id,
        level: parsed.level,
        details: [],
      }
      byId.set(parsed.id, entry)
      entries.push(entry)
      continue
    }
    const last = entries[entries.length - 1]
    if (last === undefined) loose.push(parsed.detail)
    else last.details.push(parsed.detail)
  }
  const counts: ImportLogCounts = { ok: 0, warn: 0, fail: 0, skip: 0, running: 0 }
  for (const e of entries) counts[e.level] += 1
  return {
    entries,
    loose,
    counts,
    problems: counts.warn + counts.fail,
    finished: entries.length - counts.running,
  }
}

/** 级别 → 展示字形（与宿主日志同款词汇，便于对照原始日志）。 */
const LEVEL_ICONS: Record<ImportLogLevel, string> = {
  running: '\u25b6',
  ok: '\u2713',
  warn: '\u26a0',
  fail: '\u2717',
  skip: '\u2013',
}

export function importLogLevelIcon(level: ImportLogLevel): string {
  return LEVEL_ICONS[level]
}

/**
 * 筛选：`onlyProblems = true` 时只留警告 / 失败 / 进行中（进行中要留着，否则导入过程中
 * 表头会空掉，用户看不出「正在装哪个」）；散行在该视图下一律隐藏（它们是说明文本，
 * 真有问题的项会被宿主标成 ⚠/✗ 并进入列表）。
 */
export function filterImportLogEntries(
  model: ImportLogModel,
  onlyProblems: boolean,
): ImportLogEntry[] {
  if (!onlyProblems) return model.entries
  return model.entries.filter((e) => e.level === 'warn' || e.level === 'fail' || e.level === 'running')
}
