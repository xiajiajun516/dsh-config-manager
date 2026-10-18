/**
 * 行级**三方合并**（base / ours / theirs）—— 回退时「撤销本会话的改动、保留别人的改动」的判定内核。
 *
 * 为什么需要它（2026-10-17 跨对话安全回退）：
 *  回滚点的「工作区态」是整棵树的快照，回退若直接整文件覆盖，会把别的对话在留点之后
 *  产生的修改一起抹掉。正确语义是：把 **base→ours**（本会话那次改动的反向）与
 *  **base→theirs**（别人后来的改动）同时应用到文件上 —— 即标准三方合并。
 *
 * 三方是谁（由调用方给定，本模块只管算）：
 *  · `base`  = 共同祖先：本会话改动之后、别人的改动之前的那个版本；
 *  · `ours`  = 回退目标：回滚点里记录的内容（= 本会话改之前的版本）；
 *  · `theirs` = 当前磁盘上的内容。
 *  结果为 `ours + (theirs - base)`，即撤销本会话、保留别人。
 *
 * 四条硬规矩：
 *  ① **不确定就不合并**：任一方向的 diff 被规模预算降级（`degraded`）⇒ 直接拒绝（reason=`degraded`），
 *     绝不拿一个「整块替换」的近似编辑脚本去算合并。
 *  ② **冲突绝不自动选边**：两侧改到同一处（含同一插入点）就报冲突，返回 theirs 原文 + `ok:false`，
 *     调用方必须**不写文件**并把冲突交给用户。
 *  ③ **二进制不合并**（含 NUL 即二进制，与 git 同口径）。
 *  ④ **依赖风险只提示、不假装证明**：合并要删掉的行里的标识符若仍出现在结果中，
 *     给出**启发式**风险提示（`risks`）—— 它不构成「删除不安全」的证明，也绝不因此声称合并正确。
 */
import { diffLines, looksBinary } from '../utils/line-diff.ts'
import { isUtf8RoundTrippable, probeTextForm, type TextEol, type TextShape } from './text-fidelity.ts'

/** 合并结论（`ok:false` 时调用方必须**零写入**） */
export type ThreeWayMergeReason = 'clean' | 'conflict' | 'degraded' | 'binary' | 'non-utf8'

export interface ThreeWayMergeResult {
  /** true = 结果可直接写入；false = 必须放弃写入并如实报告 */
  ok: boolean
  /** 合并结果（`ok:false` 时是 theirs 原文 —— 方便调用方做「保持现状」的比较，绝不写入） */
  text: string
  reason: ThreeWayMergeReason
  /** 冲突块数（>0 ⇒ ok=false） */
  conflicts: number
  /** 本次合并**撤销**的行数（base 有、ours 没有）与**保留**的对方新增行数（诊断用） */
  revertedLines: number
  /** 依赖风险提示（启发式；空数组 = 未发现明显风险，**不代表安全**） */
  risks: string[]
  /**
   * 输出的**字节形态**（判据 3/5）：落盘必须用 encodeTextBytes(result.text, result.shape) ——
   * result.text 里**不含** BOM，BOM 由 shape.bom 承载。
   */
  shape: TextShape
  /** 输入里出现过**不止一种行尾风格**（单个文件内混合 / 各侧风格不同）⇒ 输出的行尾已被统一，不谎称「原样」 */
  eolMixed: boolean
  /** 输出的行尾**不再逐字节等于输入**（含「显式 shape 与输入风格不同」）⇒ 行尾被改写，绝不静默 */
  eolRewritten: boolean
}

/** 一处变更块：base 的 `[start, end)` 行被替换成 `lines`（空区间 = 纯插入） */
interface ChangeBlock {
  start: number
  end: number
  lines: string[]
}

/** 标识符取样用的最小长度（太短的词（i、id）同名词满天飞，只会制造噪声） */
const RISK_TOKEN_MIN = 4

/** 不参与依赖提示的通用词（语言关键字 / 极常见标识符） */
const RISK_STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'class', 'interface', 'type',
  'public', 'private', 'readonly', 'async', 'await', 'true', 'false', 'null', 'undefined', 'this', 'void',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'throw', 'try', 'catch',
  'string', 'number', 'boolean', 'object', 'Array', 'Promise', 'Record', 'Partial', 'default',
])

/**
 * 一段文本相对 base 的**变更块**（按 base 的行区间表示）。
 * 返回 null = 该方向的 diff 被降级（规模预算），调用方必须放弃合并。
 */
function changeBlocks(base: string, target: string): ChangeBlock[] | null {
  // context=0：只要变更行，块边界自己算（省得剔上下文）
  const diff = diffLines(base, target, { context: 0 })
  if (diff.degraded) return null
  const blocks: ChangeBlock[] = []
  for (const hunk of diff.hunks) {
    // 当前块与「已消耗到 base 的哪一行」
    let block: ChangeBlock | null = null
    let cursor = Math.max(0, hunk.oldStart - 1)
    const flush = (): void => {
      if (block !== null) blocks.push(block)
      block = null
    }
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        flush()
        if (line.oldNo !== null) cursor = line.oldNo
        continue
      }
      if (line.kind === 'del') {
        const at = line.oldNo === null ? cursor : line.oldNo - 1
        if (block === null) block = { start: at, end: at, lines: [] }
        block.end = at + 1
        cursor = at + 1
        continue
      }
      // add：没有 del 时是纯插入（位置 = 当前游标）
      if (block === null) block = { start: cursor, end: cursor, lines: [] }
      block.lines.push(line.text)
    }
    flush()
  }
  return blocks
}

/** 两个块在 base 上是否**互相触碰**（保守：含边界与纯插入点） */
function touches(a: ChangeBlock, b: ChangeBlock): boolean {
  const aPoint = a.start === a.end
  const bPoint = b.start === b.end
  if (aPoint && bPoint) return a.start === b.start
  // **纯插入点落在区间端点不算冲突**：「删掉 `[s,e)`」与「在 e 处插入」可以共存（先删、再在删除后
  // 的位置插入）。真机 2026-10-17 的「撤销 A 的描述 + 保留 B 的描述」正是这种形状：A 删掉了尾部
  // 一行，B 又在其后追加了一行 —— 旧判据把它们当冲突，于是回退变成「什么都不做」。
  // 只有落在区间**内部**（严格介于 s 与 e 之间）的插入才是真正说不清的冲突。
  if (aPoint) return a.start > b.start && a.start < b.end
  if (bPoint) return b.start > a.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

/** 两侧的块是否「改成了同一件事」（内容逐行相同即可取其一，不算冲突） */
function sameChange(a: ChangeBlock, b: ChangeBlock): boolean {
  if (a.lines.length !== b.lines.length) return false
  for (let i = 0; i < a.lines.length; i += 1) if (a.lines[i] !== b.lines[i]) return false
  return true
}

/** 从被撤销的行里取「可能仍被引用」的标识符（启发式，见模块头 ④） */
function riskTokens(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const line of lines) {
    for (const token of line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      if (token.length < RISK_TOKEN_MIN) continue
      if (RISK_STOPWORDS.has(token)) continue
      seen.add(token)
    }
  }
  return [...seen]
}

/** 合并输入必须是「UTF-8 往返安全 + 行尾可无损表示」的文本（否则绝不合并、绝不写回） */
function isMergableInput(text: string): boolean {
  return isUtf8RoundTrippable(text) && probeTextForm(text).loneCr === 0
}

/** 剥掉**一个**前导 U+FEFF（BOM 由 shape.bom 承载，正文里不该再残留它） */
function stripBomPrefix(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

/**
 * 三方合并（纯函数、无 I/O）。
 *
 * **文本保真（2026-10-18 缺陷：旧实现用 join('\n') 收尾 ⇒ 把整份 CRLF 文件转成 LF）**：
 *  · 形态（EOL / BOM）显式给了 options.shape 就按它；没给就从 **theirs 探测**（磁盘上真实的那一侧），
 *    绝不擅自把 CRLF 改成 LF。落在未变更区域的行取自 base，且只含**行内容**（不含行尾），输出统一按
 *    shape.eol 收尾 —— 输入行尾若与输出不一致，用 eolMixed / eolRewritten 如实标注，不假装「原样」。
 *  · 输入按契约是**已解码文本**（BOM 已由 decodeTextBytes 剥离）；残留的前导 U+FEFF 会被剥掉并记进
 *    shape.bom，免得调用方 encode 时写出双 BOM。落盘必须用 encodeTextBytes(result.text, result.shape)。
 *  · 输入若含孤立代理项或孤立 CR（TextShape 表达不了的形态）⇒ reason='non-utf8'，**零写入**。
 *
 * 语义：结果是 `ours` 上再应用 `(theirs - base)` —— 撤销「我们从 base 改到 ours 的那部分」，
 * 同时保留「别人从 base 改到 theirs 的那部分」。
 */
export function mergeThreeWay(
  ours: string,
  base: string,
  theirs: string,
  options?: { shape?: TextShape },
): ThreeWayMergeResult {
  // 形态：显式优先；未显式给出时从 theirs 探测（主导 EOL + BOM 前缀）。
  const oursForm = probeTextForm(ours)
  const baseForm = probeTextForm(base)
  const theirsForm = probeTextForm(theirs)
  const hadBom = oursForm.bom || baseForm.bom || theirsForm.bom
  const eol: TextEol = options?.shape?.eol ?? theirsForm.eol
  // 显式形态优先；但输入侧确实带过 BOM 时绝不静默丢弃（丢 BOM 属内容改动）
  const shape: TextShape = { eol, bom: options?.shape ? options.shape.bom || hadBom : hadBom }
  const styles = new Set<TextEol>()
  for (const form of [oursForm, baseForm, theirsForm]) {
    for (const style of form.eols) styles.add(style)
  }
  /** 输入里出现过不止一种行尾风格 */
  const eolMixed = styles.size > 1
  /** 输出的行尾不再逐字节等于输入（已被统一） */
  const eolRewritten = eolMixed || (styles.size === 1 && !styles.has(eol))
  // ok:false 时 text 一律是**调用方给的 theirs 原文**（绝不落入半截合并结果）
  const empty = (reason: ThreeWayMergeReason, conflicts = 0, risks: string[] = []): ThreeWayMergeResult => ({
    ok: false, text: theirs, reason, conflicts, revertedLines: 0, risks, shape, eolMixed, eolRewritten,
  })
  // 没有基线就退化成「谁的改动都不认识」—— 调用方负责在无 base 时根本不调用本函数
  if (looksBinary(base) || looksBinary(ours) || looksBinary(theirs)) return empty('binary')
  // 非法 / 无法无损表示的文本：孤立代理项（encode 时会被替换成 U+FFFD）、孤立 CR（行尾表示不了）
  if (![ours, base, theirs].every(isMergableInput)) return empty('non-utf8')
  // 前导 U+FEFF 归 shape.bom 管；正文里剥掉它，免得它被当成「行内容」混进 diff
  const oursText = stripBomPrefix(ours)
  const baseText = stripBomPrefix(base)
  const theirsText = stripBomPrefix(theirs)
  const clean = (text: string): ThreeWayMergeResult => ({
    ok: true, text, reason: 'clean', conflicts: 0, revertedLines: 0, risks: [], shape, eolMixed, eolRewritten,
  })
  if (oursText === baseText) {
    // 本会话没改过 ⇒ 结论就是「保持别人现在的内容」（不是失败）
    return clean(theirsText)
  }
  if (theirsText === baseText) {
    // 别人没改过 ⇒ 直接回到 ours
    return clean(oursText)
  }
  if (oursText === theirsText) {
    // 双方最终内容一致 ⇒ 谁都不用动
    return clean(theirsText)
  }
  const oursBlocks = changeBlocks(baseText, oursText)
  const theirsBlocks = changeBlocks(baseText, theirsText)
  if (oursBlocks === null || theirsBlocks === null) return empty('degraded')

  // 冲突扫描：任一 ours 块与任一 theirs 块触碰且内容不同 ⇒ 冲突
  let conflicts = 0
  for (const a of oursBlocks) {
    for (const b of theirsBlocks) {
      if (!touches(a, b)) continue
      if (sameChange(a, b)) continue
      conflicts += 1
    }
  }
  if (conflicts > 0) return empty('conflict', conflicts)

  const baseLines = splitLinesOf(baseText)
  const merged: string[] = []
  const reverted: string[] = []
  let cursor = 0
  // 把两侧的块按 base 位置归并（位置相同的「同一改动」只应用一次）
  const all = [
    ...oursBlocks.map((block) => ({ block, owner: 'ours' as const })),
    ...theirsBlocks.map((block) => ({ block, owner: 'theirs' as const })),
  ].sort((left, right) => left.block.start - right.block.start)
  for (const item of all) {
    const { block, owner } = item
    if (block.start < cursor) {
      // 已被同一位置的另一个块消费（只可能是「同一改动」）—— 跳过重复应用
      continue
    }
    for (let i = cursor; i < block.start && i < baseLines.length; i += 1) merged.push(baseLines[i] as string)
    if (owner === 'ours') {
      // 这一段就是「被撤销的本会话改动」：记下它删掉了哪些行，供依赖提示用
      for (let i = block.start; i < block.end && i < baseLines.length; i += 1) reverted.push(baseLines[i] as string)
    }
    for (const line of block.lines) merged.push(line)
    cursor = Math.max(cursor, block.end)
  }
  for (let i = cursor; i < baseLines.length; i += 1) merged.push(baseLines[i] as string)
  // 行尾统一按 shape.eol 收尾（混合 / 被改写的行尾已由 eolMixed / eolRewritten 如实标注）；
  // 尾换行以**当前磁盘**（theirs）为准：我们是在它的基础上撤销本会话的改动，不擅改它原本的收尾形态
  const tail = merged.length > 0 && theirsText.endsWith('\n') ? eol : ''
  const text = merged.join(eol) + tail

  // 依赖风险（启发式）：被撤销的行里出现过、且合并结果里仍能读到的标识符
  const tokens = riskTokens(reverted)
  const risks = tokens.filter((token) => new RegExp('\\b' + token + '\\b').test(text)).slice(0, 8)
  return {
    ok: true, text, reason: 'clean', conflicts: 0, revertedLines: reverted.length, risks,
    shape, eolMixed, eolRewritten,
  }
}

/** 与 `splitLines` 同口径的本地折行（避免为了一个函数再引一层依赖） */
function splitLinesOf(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
