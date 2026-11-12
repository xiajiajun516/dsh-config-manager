/**
 * ForeignImportView 的 F-3 / F-5 源码守卫（t3）。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测），
 * 而这两条修复的关键恰好都在**装配层**：
 *  · F-3「切换来源后旧产包结果立即失效」= 事件处理必须走 resetProduced（清产包结果 +
 *    清失败横幅 + 置可见反馈）——最容易被改回「只 setSelected(id)」；
 *  · F-5「三类已知有损在导入前可见」= 纯函数 foreignLossyRows 的渲染点必须留在本文件，
 *    必须在「开始导入」按钮**之前**渲染，且逐条过 redact()。
 *
 * 行为侧（哪一条适用）由 src/ui/foreign-view.test.ts 覆盖；本文件只钉装配，断言只锚真实
 * 代码结构（函数体 / JSX 用法 / 渲染顺序），不锚注释文本。每条独立 —— 单独回退某一处
 * 只会单独变红。
 *
 * **变异验证覆盖范围（只说真做到的，不夸大）**：
 *  · F-3 走位：把 resetProduced 里的 setPreviewReset(true) 去掉 → 红灯（:52 断言）；
 *  · F-3 走位：把来源行的 onSelect 改回「只 setSelected(id)」→ 红灯；
 *  · F-5 顺序：把有损卡整块**搬到动作行之后** → 红灯；
 *  · F-5 顺序：把有损卡搬到动作行之后、**同时在原位置留一份 t('foreign.lossy.title') 引用**
 *    （即"引用点留在原处、渲染点搬走"的真实重构形态）→ 旧断言（indexOf 取首次出现）**GREEN 逃逸**，
 *    t10 的 T10-F1 实测复现；本轮已改为**按渲染块的结构性定位**，同一变异现在必红。
 *
 * 顺序断言为什么必须用「块」而不是「字符串首次出现」（T10-F1 的根因）：
 * `indexOf('…') ` 只找第一次出现，只要文件里还有任意一处提到同一个文案键，断言就会
 * 把「引用」当成「渲染点」。本文件的 renderBlocksOf() 改为：先切出 return 的顶层块，
 * 再判断某一块**自身**是否渲染了目标文案 —— 搬走渲染块就再也骗不过去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 统一换行后读取（避免 CRLF 让跨行断言静默失真）。 */
const src = fs
  .readFileSync(fileURLToPath(new URL('./ForeignImportView.tsx', import.meta.url)), 'utf8')
  .split('\r\n')
  .join('\n')

/** 取一段以 `head` 开头、到首个 `stop` 为止的源码窗口（缺 head 即断言失败）。 */
function windowOf(head: string, stop: string): string {
  const start = src.indexOf(head)
  assert.ok(start >= 0, '找不到源码片段：' + head)
  const end = src.indexOf(stop, start + head.length)
  assert.ok(end > start, '找不到源码片段的结束标记：' + stop)
  return src.slice(start, end)
}

/**
 * return 语句的顶层子块（结构性定位，T10-F1）。
 *
 * 为什么需要它：旧的顺序断言用 `indexOf(文案键)` 取**首次出现**，只要文件里别处还提到
 * 同一个键（注释之外的任意引用）就会命中，于是「把渲染块搬走」也照样绿 —— t10 实测复现。
 *
 * 本函数只切 `return (…)` 的直接子级（缩进恰好 6 空格且以 `<` / `{` 开头的行即块首），
 * 外层 JSX 不看；`skipWhitespace` 跳过空白与注释行，避免把说明文字当块。
 * 返回 [{ at, text }]，at = 相对 src 的偏移（可直接用于比较先后）。
 */
function renderBlocksOf(source: string): { at: number; text: string }[] {
  // 锚定**主 return**（含「开始导入」的那个），而不是文件里第一个 return ——
  // 组件前面还有 `if (loading) return (…)` 分支，锚错了就会去切另一棵树，
  // 让「把卡片塞进 loading 分支」这类变异以错误理由变红（t18 实测踩到并修正）。
  const marker = '  return (' + '\n    <div className={css.viewBody}>'
  let anchor = -1
  for (let from = source.indexOf(marker); from >= 0; from = source.indexOf(marker, from + 1)) {
    const tail = source.slice(from)
    if (tail.includes("t('foreign.action.import')")) { anchor = from; break }
  }
  assert.ok(anchor >= 0, '找不到主 return 的顶层容器（结构性定位失效，请同步本守卫）')
  const lines = source.slice(anchor).split('\n')
  const blocks: { at: number; text: string }[] = []
  // 行偏移（相对 anchor）：第 0 行是 '  return ('
  const offsets: number[] = []
  let acc = anchor
  for (const line of lines) {
    offsets.push(acc)
    acc += line.length + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!/^ {6}[<{]/.test(line)) continue
    // 收块：缩进回到 <= 6 且是收尾行（或遇到下一个块首）
    let end = i + 1
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] as string
      if (/^ {6}[<{]/.test(l)) break
      if (/^ {4}\}/.test(l)) break
      end = j + 1
    }
    blocks.push({ at: offsets[i] as number, text: lines.slice(i, end).join('\n') })
  }
  return blocks
}

test('F-3：切换来源/重新检测都必须走 resetProduced（清产包结果 + 清失败横幅 + 有可见反馈）', () => {
  const reset = windowOf('const resetProduced = (): void => {', '\n  }')
  assert.match(reset, /setProduced\(null\)/, '必须清掉上一次的产包结果')
  assert.match(reset, /setImportFailure\(null\)/, '上一次的失败横幅也属于上一次输入，必须一并清掉')
  assert.match(reset, /setPreviewReset\(true\)/, '重置必须留下可见反馈（绝不静默作废）')

  // 来源行的 onSelect 不得直连 setSelected（那正是 F-3 的原始缺陷形态）
  assert.match(src, /onSelect=\{handleSelect\}/, '来源行必须走 handleSelect')
  assert.doesNotMatch(
    src,
    /onSelect=\{\(id\) => \{ setSelected\(id\) \}\}/,
    'onSelect 不得只 setSelected（切来源后旧结果会继续显示）',
  )

  const select = windowOf('const handleSelect = (id: string): void => {', '\n  }')
  assert.match(select, /if \(id === selected\) return/, '同一个来源重复点击不算输入变化（不谎报已作废）')
  assert.match(select, /setSelected\(id\)/)
  assert.match(select, /resetProduced\(\)/, '切换来源必须作废旧结果')

  const refresh = windowOf('const handleRefresh = (): void => {', '\n  }')
  assert.match(refresh, /resetProduced\(\)/, '重新检测也是输入变化，同样作废旧结果')
  assert.match(src, /onClick=\{handleRefresh\}/, '「重新检测」按钮必须接上 handleRefresh')

  // 反馈必须真的渲染出来（有状态没渲染 = 仍然静默）
  assert.match(
    src,
    /\{previewReset && <Banner kind="info">\{t\('foreign\.previewReset'\)\}<\/Banner>\}/,
    'previewReset 必须以可见横幅渲染',
  )
  const runImport = windowOf('const runImport = async (): Promise<void> => {', '\n  }')
  assert.match(runImport, /setPreviewReset\(false\)/, '新产包开始时必须收回「已作废」反馈')
})

test('F-5：三类已知有损必须整卡渲染在「开始导入」之前（未产包也要可见）', () => {
  assert.match(
    src,
    /foreignLossyRows\(produced\?\.sections \?\? null, uiT\)/,
    '三条有损必须有真实数据源（产包后按包内分区判定；未产包传 null）',
  )
  assert.match(src, /t\('foreign\.lossy\.title'\)/, '必须有标题（导入前必读）')
  assert.match(src, /t\('foreign\.lossy\.hint'\)/)
  assert.match(src, /lossyRows\.map\(/, '三条有损必须逐条渲染')
  assert.match(src, /<Badge kind=\{row\.applicable \? row\.severity : 'info'\}>/, '适用性徽章按「是否适用」取色')

  // 渲染顺序（T10-F1）：必须用**渲染块结构性定位**，不得用 indexOf 取文案键的首次出现 ——
  // 后者只要文件里别处还提到同一个键就会命中，「把渲染块搬走」也照样绿（t10 已实测复现）。
  const blocks = renderBlocksOf(src)
  // F-5 的渲染块：自身（而不是别处）真正渲染了 lossyRows 的那一块
  const lossyBlock = blocks.find((b) => b.text.includes('lossyRows.map('))
  assert.ok(lossyBlock !== undefined, '主 return 里找不到渲染 lossyRows 的顶层块：有损卡被移除、改了形态，或被塞进了 loading 早退分支（主界面不可见）')
  // 「开始导入」按钮：动作行那一块（它同时含刷新与导入两个按钮）
  const actionBlock = blocks.find((b) => b.text.includes("t('foreign.action.import')"))
  assert.ok(actionBlock !== undefined, '找不到含「开始导入」的顶层块（动作行被移除）')
  // 来源列表那一块（T10-F2：有损卡必须排在它之后，不把六个来源挤出首屏）
  const sourceListBlock = blocks.find((b) => b.text.includes('css.marketReviewPage'))
  assert.ok(sourceListBlock !== undefined, '找不到来源列表所在的顶层块')
  // 「已产包才出现」的条件块：有损卡不得嵌进去（未产包也必须可见）
  const producedBlock = blocks.find((b) => b.text.includes('{produced !== null && ('))
  assert.ok(producedBlock !== undefined, '找不到「已产包才出现」的条件块')

  assert.ok(
    lossyBlock.at < actionBlock.at,
    '有损卡必须排在「开始导入」之前（导入前可见）——按渲染块比较先后，搬位必红',
  )
  assert.ok(
    lossyBlock.at > sourceListBlock.at,
    '有损卡必须排在来源列表之后（T10-F2：否则未产包时把六个来源挤出首屏）',
  )
  assert.ok(
    producedBlock.at > lossyBlock.at,
    '有损卡不得嵌在「已产包才出现」的分支里（未产包也必须可见）',
  )
  // 兜底：有损卡只能是**独立顶层块**，且不得出现在动作行之后（防止把它塞进别的块里绕开比较）
  assert.ok(
    !actionBlock.text.includes('lossyRows.map('),
    '有损卡不得被塞进动作行块内（那等于排在按钮之后）',
  )
  assert.ok(
    !producedBlock.text.includes('lossyRows.map('),
    '有损卡不得被塞进「已产包」块内（未产包时就会消失）',
  )
  // 兜底：有损卡必须出现在**主 return**里（loading 早退分支里没有它 —— 塞进去就等于
  // 只在加载态可见，主界面反而没有；t18 的变异 C 正是这种形态）
  const loadingReturn = src.indexOf('  if (loading) {')
  const mainReturn = blocks.length > 0 ? Math.min(...blocks.map((b) => b.at)) : -1
  assert.ok(loadingReturn >= 0, '找不到 loading 早退分支')
  assert.ok(
    mainReturn > loadingReturn,
    '有损卡的渲染块必须落在 loading 早退分支**之后**（不得塞进加载态分支）',
  )

  // 两条文案渲染都必须过 redact（展示文本渲染前的硬约束）
  assert.match(src, /<strong>\{redact\(row\.title\)\}<\/strong>/, '标题渲染前过 redact')
  assert.match(src, /\{redact\(row\.detail\)\}/, '说明渲染前过 redact')
})

test('F-3/F-5：本文件不得有硬编码的用户可见字符串（文案一律走字典）', () => {
  // 剥掉块注释与整行注释后，代码里不得残留中日韩字符（本文件的汉字只允许出现在注释里）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const cjk = [...code.matchAll(/[^\n]*[\u4e00-\u9fff][^\n]*/g)].map((m) => m[0].trim())
  assert.deepEqual(cjk, [], '用户可见文案必须进字典（zh/en 成对），不得在组件里硬编码：' + JSON.stringify(cjk))
})
