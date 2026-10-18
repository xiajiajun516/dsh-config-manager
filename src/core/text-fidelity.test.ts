/**
 * 文本保真原语的单元测试（2026-10-18 保真缺陷）：**保真只能靠字节证明**。
 *
 * 每条断言都用**真实字节**收口 —— 尤其是判据 1（decode ∘ encode 逐字节恒等），
 * 因为「函数返回了 ok:true」对「文件没被写坏」不构成任何证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeTextBytes,
  encodeTextBytes,
  isUtf8RoundTrippable,
  probeTextForm,
  type TextShape,
} from './text-fidelity.ts'

const enc = (text: string): number[] => [...new TextEncoder().encode(text)]
/** 组装字节：可选 BOM 前缀 + 文本的 UTF-8 字节 */
const bytesOf = (text: string, bom = false): number[] => [...(bom ? [0xef, 0xbb, 0xbf] : []), ...enc(text)]

/** 断言「可解码」并取出文本与形态（失败即测试失败，不做 any 兜底） */
function decodeOk(bytes: number[] | Uint8Array): { text: string; shape: TextShape } {
  const result = decodeTextBytes(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))
  if (!result.ok) throw new Error('期望解码成功，实际被拒：' + result.reason)
  return { text: result.text, shape: result.shape }
}

/** 断言「被拒绝」并回传 reason */
function decodeReason(bytes: number[] | Uint8Array): 'binary' | 'non-utf8' {
  const result = decodeTextBytes(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))
  if (result.ok) throw new Error('期望被拒绝，实际解码成功：' + JSON.stringify(result.text))
  return result.reason
}

/** 判据 1：解码再编码必须逐字节回到原字节 */
function assertByteExactRoundTrip(bytes: number[], label: string): void {
  const decoded = decodeOk(bytes)
  const again = encodeTextBytes(decoded.text, decoded.shape)
  assert.deepEqual([...again], bytes, label + '：decode ∘ encode 必须逐字节恒等')
}

test('F-01 空文件：0 字节可解码、形态取缺省、往返仍是 0 字节', () => {
  const { text, shape } = decodeOk([])
  assert.equal(text, '')
  assert.deepEqual(shape, { eol: '\n', bom: false })
  assert.deepEqual([...encodeTextBytes(text, shape)], [])
})

test('F-02 单行无尾换行：可往返，主导行尾取缺省 LF', () => {
  const bytes = bytesOf('const a = 1')
  const { text, shape } = decodeOk(bytes)
  assert.equal(text, 'const a = 1')
  assert.equal(shape.eol, '\n')
  assertByteExactRoundTrip(bytes, 'F-02')
})

test('F-03 LF 多行 + 尾换行：主导行尾 LF', () => {
  const bytes = bytesOf('a\nb\nc\n')
  const { text, shape } = decodeOk(bytes)
  assert.equal(text, 'a\nb\nc\n')
  assert.equal(shape.eol, '\n')
  assertByteExactRoundTrip(bytes, 'F-03')
})

test('F-04 CRLF：text 原样保留 CRLF（不改写行尾）、主导行尾 CRLF、往返逐字节相同', () => {
  const bytes = bytesOf('a\r\nb\r\nc\r\n')
  const { text, shape } = decodeOk(bytes)
  assert.equal(text, 'a\r\nb\r\nc\r\n', 'decode 绝不把 CRLF 折成 LF')
  assert.equal(shape.eol, '\r\n')
  assertByteExactRoundTrip(bytes, 'F-04')
})

test('F-05 混合行尾：主导取严格多者、text 逐字节保留混合形态（往返仍恒等）', () => {
  // 2 个 CRLF + 1 个 LF ⇒ 主导 CRLF
  const bytes = bytesOf('a\r\nb\r\nc\nd\r\n')
  const { text, shape } = decodeOk(bytes)
  assert.equal(shape.eol, '\r\n')
  assert.equal(text, 'a\r\nb\r\nc\nd\r\n')
  assert.equal(probeTextForm(text).eols.length, 2, '如实报告「两种行尾都出现过」')
  assertByteExactRoundTrip(bytes, 'F-05')
  // 反例方向：2 个 LF + 1 个 CRLF ⇒ 主导 LF
  const reversed = bytesOf('a\nb\nc\r\nd\n')
  assert.equal(decodeOk(reversed).shape.eol, '\n')
  assertByteExactRoundTrip(reversed, 'F-05b')
})

test('F-06 混合行尾平局（1 CRLF + 1 LF）⇒ 取 LF（不猜、且往返恒等）', () => {
  const bytes = bytesOf('a\r\nb\nc\n')
  const { shape } = decodeOk(bytes)
  assert.equal(shape.eol, '\n', '严格多者胜：相等时回落到 LF')
  assertByteExactRoundTrip(bytes, 'F-06')
})

test('F-07 带 BOM：decode 剥掉 3 字节 BOM 并记账，encode 原样补回（逐字节恒等）', () => {
  const bytes = bytesOf('a\r\nb\r\n', true)
  const { text, shape } = decodeOk(bytes)
  assert.equal(shape.bom, true)
  assert.equal(text, 'a\r\nb\r\n', '正文里不再残留 U+FEFF')
  assert.equal(text.startsWith('\uFEFF'), false)
  assert.deepEqual([...encodeTextBytes(text, shape)].slice(0, 3), [0xef, 0xbb, 0xbf])
  assertByteExactRoundTrip(bytes, 'F-07')
})

test('F-08 无 BOM：shape.bom 为 false，encode 不加前缀', () => {
  const bytes = bytesOf('a\nb\n')
  const { shape } = decodeOk(bytes)
  assert.equal(shape.bom, false)
  assert.deepEqual([...encodeTextBytes('x', { eol: '\n', bom: false })], [0x78])
})

test('F-09 Latin-1（0xE9）⇒ non-utf8（fail-closed，绝不按 U+FFFD 读出再写回）', () => {
  // "café" 的 Latin-1 字节：0xE9 不是合法 UTF-8 起始字节
  assert.equal(decodeReason([0x63, 0x61, 0x66, 0xe9]), 'non-utf8')
})

test('F-10 GBK 中文（D6 D0 CE C4）⇒ non-utf8', () => {
  assert.equal(decodeReason([0xd6, 0xd0, 0xce, 0xc4]), 'non-utf8')
})

test('F-11 UTF-16LE 带 BOM（FF FE …）⇒ non-utf8', () => {
  assert.equal(decodeReason([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]), 'non-utf8')
})

test('F-12 已知口径：无 BOM 且恰好也是合法 UTF-8 的 UTF-16LE 不做猜测（往返仍恒等 ⇒ 不会写坏字节）', () => {
  // '你好' 的 UTF-16LE = 60 4F 7D 59 —— 4 个合法 ASCII 字节，字节层面无法与 UTF-8 区分。
  const bytes = [0x60, 0x4f, 0x7d, 0x59]
  const { text, shape } = decodeOk(bytes)
  assert.deepEqual([...text].map((char) => char.charCodeAt(0)), bytes, '不猜编码：按 UTF-8 如实读出')
  assert.deepEqual([...encodeTextBytes(text, shape)], bytes, '关键：往返逐字节相同，绝不写坏')
  assertByteExactRoundTrip(bytes, 'F-12')
})

test('F-13 含 NUL ⇒ binary（口径 = 前 8 KiB，与既有实现一致）', () => {
  assert.equal(decodeReason([0x61, 0x00, 0x62]), 'binary')
  assert.equal(decodeReason([0x00]), 'binary')
  // 边界：第 8193 个字节才是 NUL —— 与既有「前 8 KiB」口径一致，不额外扩大判定
  const late = [...enc('a'.repeat(8192)), 0x00]
  assert.equal(decodeOk(late).text.length, 8193)
})

test('F-14 孤立 CR（老 Mac 行尾）⇒ non-utf8（TextShape 表示不了 ⇒ 拒绝，绝不悄悄改成 LF）', () => {
  assert.equal(decodeReason(bytesOf('a\rb\r')), 'non-utf8')
  // 但 CRLF 里的 CR 不算孤立
  assert.equal(decodeOk(bytesOf('a\r\nb')).shape.eol, '\r\n')
})

test('F-15 表驱动：判据 1（逐字节恒等）覆盖 LF / CRLF / 混合 / BOM / 中文 / emoji / 空行', () => {
  const fixtures: Array<{ label: string; bytes: number[] }> = [
    { label: '空文件', bytes: [] },
    { label: '只有换行', bytes: bytesOf('\n') },
    { label: '空行夹杂', bytes: bytesOf('a\n\nb\n') },
    { label: '中文 LF', bytes: bytesOf('你好\n世界\n') },
    { label: 'emoji（合法代理对）', bytes: bytesOf('ok 😀 done\n') },
    { label: 'CRLF 中文', bytes: bytesOf('你好\r\n世界\r\n') },
    { label: 'BOM + CRLF', bytes: bytesOf('a\r\nb\r\n', true) },
    { label: 'BOM + 中文 LF', bytes: bytesOf('你好\n', true) },
    { label: '混合行尾', bytes: bytesOf('a\r\nb\nc\r\n') },
    { label: '单行无尾换行', bytes: bytesOf('x = 1') },
    { label: '尾随空行', bytes: bytesOf('a\n\n') },
  ]
  for (const fixture of fixtures) assertByteExactRoundTrip(fixture.bytes, 'F-15 ' + fixture.label)
})

test('F-16 代理项判据：合法代理对不误判，孤立代理项必须判 false', () => {
  assert.equal(isUtf8RoundTrippable('😀'), true)
  assert.equal(isUtf8RoundTrippable('\uD83D\uDE00'), true)
  assert.equal(isUtf8RoundTrippable('\uD83D'), false, '孤立高代理项')
  assert.equal(isUtf8RoundTrippable('\uDE00'), false, '孤立低代理项')
  assert.equal(isUtf8RoundTrippable('a\uD83Db'), false, '高代理项后面不是低代理项')
  // 这就是必须拒绝的原因：TextEncoder 会把孤立代理项写成 U+FFFD（内容损毁）
  assert.deepEqual([...new TextEncoder().encode('\uD83D')], [0xef, 0xbf, 0xbd])
})

test('F-17 encodeTextBytes：bom=false 不动字节；bom=true 恰好加 3 字节前缀且不改行尾', () => {
  const text = 'a\r\nb'
  assert.deepEqual([...encodeTextBytes(text, { eol: '\n', bom: false })], enc(text), 'eol 不参与字节生成')
  assert.deepEqual([...encodeTextBytes(text, { eol: '\r\n', bom: false })], enc(text))
  assert.deepEqual([...encodeTextBytes(text, { eol: '\n', bom: true })], [0xef, 0xbb, 0xbf, ...enc(text)])
})

test('F-18 probeTextForm：纯描述（主导行尾 / BOM 前缀 / 出现过的行尾 / 孤立 CR 计数）', () => {
  assert.deepEqual(probeTextForm('a\nb\n'), { eol: '\n', bom: false, eols: ['\n'], loneCr: 0 })
  assert.deepEqual(probeTextForm('a\r\nb\r\n'), { eol: '\r\n', bom: false, eols: ['\r\n'], loneCr: 0 })
  assert.deepEqual(probeTextForm('a\r\nb\n'), { eol: '\n', bom: false, eols: ['\r\n', '\n'], loneCr: 0 })
  assert.deepEqual(probeTextForm('a\rb'), { eol: '\n', bom: false, eols: [], loneCr: 1 })
  assert.deepEqual(probeTextForm('\uFEFFa\n'), { eol: '\n', bom: true, eols: ['\n'], loneCr: 0 })
  assert.deepEqual(probeTextForm(''), { eol: '\n', bom: false, eols: [], loneCr: 0 })
})
