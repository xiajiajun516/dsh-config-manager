/**
 * 文本保真（text fidelity）—— 字节 ↔ 文本的**无损往返**与「形态」（行尾 / BOM）判定。
 *
 * 为什么需要它（2026-10-18 保真缺陷）：
 *  回滚 / 跨对话三方合并是**文本**级算法，但工作区文件是**字节**。用 'Buffer.toString("utf8")' 去解一个
 *  GBK / Latin-1 文件**不会抛错**（非法字节被替换成 U+FFFD），合并结果再按 UTF-8 写回 ⇒ 原文件被
 *  **mojibake 覆盖、内容不可逆损毁**。换行符同理：把 CRLF 折成 LF 再 join('\n')，整份文件的行尾被
 *  静默改写（Windows 上 = 全文件 diff）。
 *
 * 两条硬规矩：
 *  ① **无损或拒绝**：解出来的文本必须能逐字节编码回原字节（decodeTextBytes 自己证明这一点，见判据 1）；
 *     做不到就 ok:false，调用方必须**零写入** —— 绝不「差不多就行」。
 *  ② **形态不猜**：行尾只有 '\n' | '\r\n' 两种可无损表示的形式；孤立 '\r'（老 Mac 风格）无法用它们表示
 *     ⇒ 同样 ok:false，而不是悄悄把它当 LF 写掉。
 *
 * ── 归一化口径（**唯一的契约**，判据 1 就建立在这三条上）──
 *  · decodeTextBytes **只做一件事**：剥掉开头的 UTF-8 BOM（EF BB BF）。**不改写任何行尾** ——
 *    返回的 text 里 CRLF / LF 原样保留，因此**混合行尾**的文件也能逐字节往返。
 *  · shape.eol 描述这份文本的**主导行尾**（完整的 CRLF 数**严格多于**纯 LF 数时为 '\r\n'；
 *    相等 / 没有整行行尾 / 空文本一律 '\n'）。它供「需要新建行」的一方（三方合并）决定输出行尾，
 *    **不影响** encodeTextBytes 的字节。
 *  · encodeTextBytes(text, shape) **只做一件事**：shape.bom 为真时补回 3 字节 BOM。**不改写任何行尾**。
 *    于是恒有 encodeTextBytes(d.text, d.shape) 逐字节等于原始 bytes（d = decodeTextBytes(bytes)）。
 *  · 行尾的**归一化只发生在三方合并**（rollback-merge.ts）：输出按 shape.eol 统一，并用 eolMixed /
 *    eolRewritten 如实标注，绝不假装「原样保留」。
 *
 * ── 已知口径（**不猜、不谎报**）──
 *  · 前 8 KiB 出现 NUL 字节 ⇒ 'binary'（与 utils/line-diff.ts、rollback-point.ts 同一口径）。
 *  · 非法 UTF-8（超长编码、孤立代理项的 CESU/WTF-8 编码、UTF-16 的 FF FE 前缀等）⇒ 'non-utf8'。
 *  · 「恰好也是合法 UTF-8 的无 BOM UTF-16LE」在**字节层面无法与 UTF-8 区分**（例：UTF-16LE 的
 *    你好 = 60 4F 7D 59，是 4 个合法 ASCII 字节）。本模块**不猜编码**：它会被当作合法 UTF-8 读出，
 *    但往返仍逐字节相同 ⇒ **不会写坏字节**（要「猜编码」需要额外启发式，那才是真正的越权）。
 */

/** 行尾形态：只有 LF 与 CRLF 两种能被无损表示的换行符（孤立 CR 一律拒绝，见模块头 ②）。 */
export type TextEol = '\n' | '\r\n'

/** 一份文本的「形态」：主导行尾 + 是否带 UTF-8 BOM。 */
export interface TextShape {
  /** 主导行尾（严格多者胜；相等 / 无行尾 / 空文本 ⇒ '\n'） */
  eol: TextEol
  /** 是否带 UTF-8 BOM（EF BB BF） */
  bom: boolean
}

/** 已解码文本的形态探测结果（合并侧用：只如实描述，不做任何改写）。 */
export interface TextForm extends TextShape {
  /** 这份文本里**出现过**的行尾风格（同一份文件可能两种都有 ⇒ 长度为 2） */
  eols: TextEol[]
  /** 孤立 CR（其后不是 LF）的个数；> 0 ⇒ 行尾无法用 TextShape 无损表示 */
  loneCr: number
}

/** 解码结论。ok:false 时调用方必须**零写入**（绝不 mojibake 写回）。 */
export type DecodeTextResult =
  | { ok: true; text: string; shape: TextShape }
  | { ok: false; reason: 'binary' | 'non-utf8' }

/** NUL 探测窗口（与 line-diff / rollback-point 同口径：只看前 8 KiB） */
const NUL_PROBE_BYTES = 8192

/** UTF-8 BOM 字节 */
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])

/** 解码器：fatal = 非法 UTF-8 直接抛错（不替换成 U+FFFD）；ignoreBOM = 不代我们剥 BOM（剥与不剥由本模块决定）。 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const UTF8_ENCODER = new TextEncoder()

/** 前 8 KiB 是否出现 NUL 字节（与既有 binary 判据一致） */
function containsNul(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, NUL_PROBE_BYTES)
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true
  }
  return false
}

/** 是否以 UTF-8 BOM（EF BB BF）开头 */
function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** 逐字节相等（保真自证用） */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

/**
 * 文本能否无损编码成 UTF-8 字节。
 * 唯一会失败的形态是**孤立代理项**（TextEncoder 会把它替换成 U+FFFD ⇒ 写回即内容损毁）。
 */
export function isUtf8RoundTrippable(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理项后面必须紧跟低代理项，否则是孤立代理项
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/** 扫描行尾：完整 CRLF / 纯 LF / 孤立 CR 各计数（三者互斥） */
function scanEol(text: string): { crlf: number; lf: number; loneCr: number } {
  let crlf = 0
  let lf = 0
  let loneCr = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1
        i += 1
      } else {
        loneCr += 1
      }
      continue
    }
    if (code === 10) lf += 1
  }
  return { crlf, lf, loneCr }
}

/**
 * 探测一段**已解码文本**的形态：主导行尾、BOM 前缀、出现过的行尾风格、孤立 CR 计数。
 * 纯描述、零改写（shape.eol 只用来决定「新建行」的行尾）。
 */
export function probeTextForm(text: string): TextForm {
  const bom = text.startsWith('\uFEFF')
  const body = bom ? text.slice(1) : text
  const scan = scanEol(body)
  const eols: TextEol[] = []
  if (scan.crlf > 0) eols.push('\r\n')
  if (scan.lf > 0) eols.push('\n')
  return {
    // 严格多者胜：相等 / 没有整行行尾 / 空文本 ⇒ '\n'
    eol: scan.crlf > scan.lf ? '\r\n' : '\n',
    bom,
    eols,
    loneCr: scan.loneCr,
  }
}

/**
 * 字节 → 文本（**无损或拒绝**）。
 *
 * 自证（判据 1）：成功时一定有 encodeTextBytes(result.text, result.shape) **逐字节等于**入参 bytes。
 *
 * 拒绝的两种形态（调用方**必须零写入**并按 reason 如实报告）：
 *  · 'binary'：前 8 KiB 含 NUL（不是文本，行 / 合并算法对它没有定义）；
 *  · 'non-utf8'：非法 UTF-8，或解码结果无法逐字节往返，或含孤立 CR（超出两种 EOL 的表示能力）。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodeTextResult {
  if (containsNul(bytes)) return { ok: false, reason: 'binary' }
  const bom = startsWithUtf8Bom(bytes)
  const body = bom ? bytes.subarray(UTF8_BOM.length) : bytes
  let text: string
  try {
    text = UTF8_DECODER.decode(body)
  } catch {
    return { ok: false, reason: 'non-utf8' }
  }
  // 自证：解出来的文本必须能逐字节编码回原字节（防「解码器接受了、编码器却写不回」的边角形态）
  if (!bytesEqual(UTF8_ENCODER.encode(text), body)) return { ok: false, reason: 'non-utf8' }
  const form = probeTextForm(text)
  // 孤立 CR：TextShape 表达不了 ⇒ 宁可拒绝，也绝不悄悄把它改成 LF
  if (form.loneCr > 0) return { ok: false, reason: 'non-utf8' }
  return { ok: true, text, shape: { eol: form.eol, bom } }
}

/**
 * 文本 → 字节（**保真**）。
 *
 * 契约：text 必须是 decodeTextBytes 输出的形态（BOM 已剥）。本函数**不改写任何行尾**，只在
 * shape.bom 为真时补回 3 字节 BOM ⇒ 与 decodeTextBytes 互逆（判据 1）。
 *
 * 注意：shape.eol 在这里**不参与**字节生成 —— 行尾归一化只发生在三方合并里；在这里归一化就意味着
 * 混合行尾 / CRLF 文件无法逐字节往返。含孤立代理项的文本按 UTF-8 替换字符写出（与 TextEncoder 一致）：
 * 调用方应先在 decodeTextBytes / mergeThreeWay 处把好关。
 */
export function encodeTextBytes(text: string, shape: TextShape): Uint8Array {
  const body = UTF8_ENCODER.encode(text)
  if (!shape.bom) return body
  const out = new Uint8Array(body.length + UTF8_BOM.length)
  out.set(UTF8_BOM, 0)
  out.set(body, UTF8_BOM.length)
  return out
}
