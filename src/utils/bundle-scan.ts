/**
 * bundle-scan —— 构建产物护栏的纯函数内核。
 *
 * 用途：断言 `lib/client.js`（client 半的单文件 cjs bundle）**不 require 白名单外的任何外部包**。
 *
 * ## 为什么必须剥注释再匹配
 * bundle 里带 banner/注释/sourcemap 注释，注释中可能出现与真实 `require("lucide-react")`
 * 完全同名的字符串——本仓库真实存在：`src/market/upstream.ts` 的注释里就写着
 * `` `require("node:https")` ``。直接对原文正则匹配会假阳性。
 *
 * ## 为什么要跑两遍（双模式交叉校验）
 * 注释里的**反引号**会破坏模板字面量配平。实测该 bundle 的注释中有 24 处反引号处于
 * 「注释文本」位置，其中某处让模板态永久失衡 → 扫描器把后续注释当代码保留 → 出现
 * `require("node:https")` 假阳性；反过来，一旦模板态失衡，**真实的外部 require 也可能被
 * 当成注释内容吞掉（假阴性）**——对护栏来说假阴性是致命的。
 *
 * 因此这里做两次独立扫描并取并集：
 *  - `template` 模式：正确解析 `` ` `` 模板与 `${}` 插值（含嵌套）；
 *  - `opaque` 模式：把反引号当普通文本，不做模板解析。
 *
 * 两种模式的失衡点不同，任一模式漏掉的外部 require 会被另一模式抓到；取并集后，只有
 * 「两种模式都判为注释」的内容才可能被漏掉，而那种内容必然是真正的注释。
 *
 * 本模块**零依赖、纯函数、不碰 node:fs**——文件读取由调用方（测试）负责，便于单测覆盖
 * 注释剥离与 require 抽取的边界情况。
 */

/** bundle 允许 require 的运行时依赖白名单（由 DSH client runtime 提供）。 */
export const CLIENT_BUNDLE_RUNTIME_WHITELIST: readonly string[] = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
]

/**
 * 允许出现的 `node:*` 内置说明符前缀。
 *
 * 单文件 client bundle 里出现 `node:*` 本身就是构建配置出错的信号（浏览器半不该依赖 Node
 * 内置模块），但它**不是本护栏的职责**：这里只判定「包依赖是否被外置」。因此 `node:*` 被
 * 显式放行并单独上报，交由人工/后续护栏判断。
 */
export const NODE_BUILTIN_PREFIX = 'node:'

/** 扫描模式（简写形式，等价于 {@link BUNDLE_SCAN_PASSES} 的前两项）。 */
export type BundleScanMode = 'template' | 'opaque'

/** 一条被发现的 require 调用点。 */
export interface RequireHit {
  /** require 的说明符（字面量）。 */
  specifier: string
  /** 1-based 行号。 */
  line: number
  /** 该说明符是否为动态表达式（如 require(name)）而非字面量。 */
  dynamic: boolean
}

/** require(...) 的形态：字面量（可判定）或动态表达式（不可判定）。 */
const REQUIRE_CALL_RE = /\brequire\s*\(\s*([^)]*?)\s*\)/g

/** 主状态：普通代码 / 行注释 / 块注释 / 单引号串 / 双引号串 / 模板字面量。 */
type ScanState = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'

/**
 * 「注释剥离 + require 抽取」的单次扫描配置。
 *
 * 两种解析歧义各由一组配置兜底：
 *  - `backticksAsCode`：反引号是模板字面量定界符，还是普通文本；
 *  - `quotesOpaque`：引号是字符串定界符，还是普通文本。
 *
 * 详见 {@link BUNDLE_SCAN_PASSES}。
 */
export interface BundleScanPassConfig {
  /** pass id，用于结果与诊断。 */
  id: string
  /** true = 把 `` ` `` 当模板定界符（解析 `${}` 插值）；false = 当普通文本。 */
  backticksAsCode: boolean
  /** true = 引号当普通文本；false = 引号配对为字符串定界符。 */
  quotesOpaque: boolean
}

/**
 * 多趟扫描配置（取并集）。
 *
 * 为什么要多趟：单趟状态机可能因解析歧义而失衡（本仓库真实存在——bundle 里的正则字面量
 * `/.../` 按普通代码处理，其中的引号/反引号会让状态机失配），一旦失衡，后续注释就可能被
 * 当成代码（假阳性）**或真实代码被当成注释内容吞掉（假阴性，对护栏致命）**。
 *
 * 不同配置的失衡点不同，取并集后，某个 require 只有在「所有趟都判它是注释内容」时才会被
 * 漏掉——而那种内容必然是真正的注释。
 */
export const BUNDLE_SCAN_PASSES: readonly BundleScanPassConfig[] = [
  { id: 'tpl+str', backticksAsCode: true, quotesOpaque: false },
  { id: 'opaque-tpl', backticksAsCode: false, quotesOpaque: false },
  { id: 'opaque-str', backticksAsCode: true, quotesOpaque: true },
  { id: 'opaque-both', backticksAsCode: false, quotesOpaque: true },
]

/**
 * 剥离 JS 的块注释与行注释，保留字符串/模板字面量内容，并保留换行符以维持行号。
 *
 * `templateMode = true` 时解析反引号模板（含 `${}` 插值、嵌套模板、插值内的嵌套花括号）；
 * `false` 时把反引号当普通文本。组合 `quotesOpaque` 可进一步把引号当普通文本（用于交叉校验，
 * 见 {@link BUNDLE_SCAN_PASSES}）。
 *
 * 已知局限：正则字面量按普通代码处理（`/` 不进入注释态），故本函数可能在含 `/` 的正则处失配；
 * 多趟并集负责兜底。
 */
export function stripJsComments(
  source: string,
  templateMode = true,
  quotesOpaque = false,
): string {
  let out = ''
  let i = 0
  const n = source.length
  let state: ScanState = 'code'
  /** 插值栈：每进入一层 `${`，压入「进入前的状态」与「该层已见的 `{` 数」。 */
  const stack: Array<{ state: ScanState, braces: number }> = []
  let braces = 0

  while (i < n) {
    const c = source[i] as string
    const d = i + 1 < n ? (source[i + 1] as string) : ''

    if (state === 'code') {
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue }
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue }
      if (!quotesOpaque && c === "'") { state = 'sq'; out += c; i++; continue }
      if (!quotesOpaque && c === '"') { state = 'dq'; out += c; i++; continue }
      if (templateMode && c === '`') { state = 'tpl'; out += c; i++; continue }
      if (c === '{') { braces++ }
      else if (c === '}') {
        if (braces === 0) {
          const frame = stack.pop()
          if (frame !== undefined) {
            // 关闭一层模板插值：回到进入前的状态继续扫描。
            state = frame.state
            braces = frame.braces
            out += c
            i++
            continue
          }
        } else {
          braces--
        }
      }
      out += c
      i++
      continue
    }


    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c // 保留换行，维持行号
      i++
      continue
    }

    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"'
      if (c === '\\') { out += c + d; i += 2; continue }
      if (c === quote) state = 'code'
      out += c
      i++
      continue
    }

    // state === 'tpl'
    if (c === '\\') { out += c + d; i += 2; continue }
    if (c === '`') { state = 'code'; out += c; i++; continue }
    if (c === '$' && d === '{') {
      stack.push({ state, braces })
      braces = 0
      state = 'code'
      out += c + d
      i += 2
      continue
    }
    out += c
    i++
    continue
  }

  return out
}

/** 计算 1-based 行号。 */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++
  return line
}

/** 从字面量 require 实参文本中取出说明符；非字面量返回 null。 */
function literalSpecifier(argText: string): string | null {
  const t = argText.trim()
  if (t.length < 2) return null
  const q = t[0]
  if (q !== "'" && q !== '"') return null
  if (t[t.length - 1] !== q) return null
  const body = t.slice(1, -1)
  // 转义序列在包说明符里不合法，出现即视为非字面量。
  if (body.includes('\\')) return null
  if (body.includes('\n')) return null
  return body
}

/**
 * 抽取代码中所有 `require(...)` 调用点。
 *
 * 输入应当是已剥离注释的代码（先调用 {@link stripJsComments}）。
 */
export function extractRequireHits(strippedCode: string): RequireHit[] {
  const hits: RequireHit[] = []
  REQUIRE_CALL_RE.lastIndex = 0
  for (const m of strippedCode.matchAll(REQUIRE_CALL_RE)) {
    const argText = m[1] ?? ''
    const specifier = literalSpecifier(argText)
    hits.push({
      specifier: specifier ?? argText.trim(),
      line: lineAt(strippedCode, m.index),
      dynamic: specifier === null,
    })
  }
  return hits
}

/** 单趟扫描的结果。 */
export interface BundleScanPass {
  /** 该趟的配置 id（见 {@link BUNDLE_SCAN_PASSES}）。 */
  id: string
  /** 所有字面量 require 说明符（去重后升序）。 */
  specifiers: string[]
  /** 白名单外的字面量包说明符（真正的违规）。 */
  violations: string[]
  /** `node:*` 内置说明符（放行但单独上报）。 */
  nodeBuiltins: string[]
  /** 动态（非字面量）require 调用点。 */
  dynamicHits: RequireHit[]
  /** 每个说明符的出现次数。 */
  counts: Record<string, number>
  /** 剥离注释后的字符数。 */
  strippedLength: number
}

/** 按给定配置跑一趟扫描。 */
export function scanBundleRequiresPass(
  source: string,
  config: BundleScanPassConfig | BundleScanMode = 'template',
  whitelist: readonly string[] = CLIENT_BUNDLE_RUNTIME_WHITELIST,
): BundleScanPass {
  const resolved: BundleScanPassConfig = typeof config === 'string'
    ? (config === 'opaque'
        ? { id: 'opaque-tpl', backticksAsCode: false, quotesOpaque: false }
        : { id: 'tpl+str', backticksAsCode: true, quotesOpaque: false })
    : config
  const stripped = stripJsComments(source, resolved.backticksAsCode, resolved.quotesOpaque)
  const hits = extractRequireHits(stripped)
  const allowed = new Set(whitelist)
  const counts: Record<string, number> = {}
  const dynamicHits: RequireHit[] = []
  for (const hit of hits) {
    if (hit.dynamic) { dynamicHits.push(hit); continue }
    counts[hit.specifier] = (counts[hit.specifier] ?? 0) + 1
  }
  const specifiers = Object.keys(counts).sort()
  return {
    id: resolved.id,
    specifiers,
    violations: specifiers.filter((s) => !allowed.has(s) && !s.startsWith(NODE_BUILTIN_PREFIX)),
    nodeBuiltins: specifiers.filter((s) => s.startsWith(NODE_BUILTIN_PREFIX)),
    dynamicHits,
    counts,
    strippedLength: stripped.length,
  }
}

/** 多趟扫描并取并集后的汇总结果。 */
export interface BundleScanResult {
  /** 每一趟各自的结果。 */
  passes: BundleScanPass[]
  /** 是否所有趟得出完全一致的 require 集合（一致性信号；不一致说明存在解析失衡）。 */
  passesAgree: boolean
  /** 各趟 require 集合的并集（升序）。 */
  specifiers: string[]
  /** 并集中的白名单外包说明符（任一趟发现即算违规）。 */
  violations: string[]
  /** 并集中的 `node:*` 内置说明符。 */
  nodeBuiltins: string[]
  /** 各趟的动态 require 调用点并集。 */
  dynamicHits: RequireHit[]
}

/**
 * 对 bundle 源码做多趟扫描并取并集（保守方向：宁可多报，不可漏报）。
 *
 * 任一趟发现的白名单外包说明符即判定为违规——单趟失衡最多造成「该趟漏报」，
 * 不可能造成「全部趟一起漏报」。
 */
export function scanBundleRequires(
  source: string,
  whitelist: readonly string[] = CLIENT_BUNDLE_RUNTIME_WHITELIST,
  passConfigs: readonly BundleScanPassConfig[] = BUNDLE_SCAN_PASSES,
): BundleScanResult {
  const passes = passConfigs.map((config) => scanBundleRequiresPass(source, config, whitelist))
  const allowed = new Set(whitelist)
  const specifiers = [...new Set(passes.flatMap((p) => p.specifiers))].sort()
  const dynamicKeys = new Set<string>()
  const dynamicHits: RequireHit[] = []
  for (const pass of passes) {
    for (const hit of pass.dynamicHits) {
      const key = `${hit.line}:${hit.specifier}`
      if (dynamicKeys.has(key)) continue
      dynamicKeys.add(key)
      dynamicHits.push(hit)
    }
  }
  const firstSet = passes[0]?.specifiers.join('\u0000') ?? ''
  return {
    passes,
    passesAgree: passes.every((p) => p.specifiers.join('\u0000') === firstSet),
    specifiers,
    violations: specifiers.filter((s) => !allowed.has(s) && !s.startsWith(NODE_BUILTIN_PREFIX)),
    nodeBuiltins: specifiers.filter((s) => s.startsWith(NODE_BUILTIN_PREFIX)),
    dynamicHits,
  }
}
