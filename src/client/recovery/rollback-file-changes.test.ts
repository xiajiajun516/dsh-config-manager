/**
 * 回退预览文件清单（共享组件）的源码级守卫。
 *
 * 为什么需要：清单的版式与诚实边界（图标 | 目录弱化 + 基名 | 右对齐统计；删除行写「删除」；
 * 行数不可信写「行数未统计」，绝不写 0）**类型检查与行为单测都抓不到** —— React 壳不跑组件框架，
 * 而它现在被两处调用：聊天里的回退预览与设置页回滚卡的预览弹窗（2026-10-12 用户要求
 * 「环境页的回退预览也要一眼看清被改动的文件」）。谁把这两处又各自写一份、或把「删除」写成
 * +0 −N，这里直接红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHANGES = join(HERE, 'RollbackFileChanges.tsx')
const CARD = join(HERE, 'RollbackCard.tsx')
const DIALOG = join(HERE, '../chat/RollbackReviewDialog.tsx')
const PANE = join(HERE, 'RollbackDiffPane.tsx')
const TABLE = join(HERE, '../common/DiffTable.tsx')
const TAB = join(HERE, '../chat/RollbackDiffTab.tsx')
const CSS = join(HERE, '../config-manager.module.css')
const PLAN = join(HERE, '../library/RestorePlanView.tsx')
const RECOVERY_LOCALES = join(HERE, 'recovery-locales.ts')
const CLIENT_LOCALES = join(HERE, '../locales.ts')
const PROXY = join(HERE, '../index.ts')

test('清单结构：容器 + 两类行 + 图标 + 目录弱化 + 右对齐统计（源级）', () => {
  const src = readFileSync(CHANGES, 'utf8')
  assert.match(src, /className=\{css\.rollbackFileList\}/, '清单必须包进 .rollbackFileList 容器')
  assert.equal([...src.matchAll(/role="listitem"/g)].length, 2, '两类行（改动 / 删除）都必须是 listitem')
  assert.match(src, /splitRollbackPath\(file\.path\)/, '文件行必须切出目录前缀（只画基名时读不出「在哪」）')
  assert.match(src, /className=\{css\.rollbackFileDir\}/, '目录段必须有独立的弱化类')
  assert.match(src, /className=\{css\.rollbackFileStat\}/, '±行数必须包在紧跟文件名的统计块里')
  assert.match(src, /RollbackFileIcon/, '文件名前面必须有文件类型图标')
  assert.match(src, /render=\{renderFileIcon\}/, '图标的外部来源（dsh-better-sidebar）必须接到每一行')
  assert.match(src, /data-kind=\{previewFileStatusKnown\(file\.status\) \? file\.status : undefined\}/, '语义色条只在形状可判定时上色（读不出就不画）')
  assert.equal([...src.matchAll(/data-off/g)].length, 0, '共享清单里不得有整块降透明的 data-off（旧做法）')
})

test('诚实边界：删除写「删除」、行数不可信写「行数未统计」（源级）', () => {
  const src = readFileSync(CHANGES, 'utf8')
  assert.match(src, /rollback\.preview\.file\.deleted/, '整文件删除必须写「删除」而不是 +0 −N')
  assert.match(src, /rollback\.preview\.file\.unknown/, '行数不可信必须写「行数未统计」')
  assert.match(src, /if \(status === 'delete'\)/, '删除只由引擎给的 status 判定（不猜、不从行数反推）')
  assert.doesNotMatch(src, /added === 0\s*[?&=|)]/, '绝不从 added === 0 反推删除（清空成 0 行与删除是两件事）')
  assert.doesNotMatch(src, /chat\.preview/, '字典键由调用方给（组件只收已翻译文本），不得自己引聊天字典')
})

test('点文件名看差异：路径那一格是按钮，且只走调用方注入的通道（源级）', () => {
  const src = readFileSync(CHANGES, 'utf8')
  assert.equal([...src.matchAll(/css\.fileViewBtn/g)].length, 0, '尾部那颗独立「查看」按钮必须整体消失')
  const buttons = src.match(/<button[\s\S]{0,400}?<\/button>/g) ?? []
  const pathBtn = buttons.find((block) => block.includes('css.rollbackFilePath'))
  assert.ok(pathBtn !== undefined, '路径那一格本身必须是 <button>（点文件名即跳转）')
  assert.ok(pathBtn.includes('view.onView(file.path)'), '点文件名必须走注入的唯一打开入口（组件不自己找通道）')
  assert.ok(pathBtn.includes('disabled={view.disabled}'), '忙态 / 无可写目标时必须禁用（判据由调用方给）')
  assert.ok(pathBtn.includes('view.hint(file.path)'), '无障碍名必须带这个文件的全路径（同名按钮一屏好几个）')
  const removals = src.slice(src.indexOf('removals.map'))
  assert.doesNotMatch(removals, /<button/, '删除行不是按钮：它的差异读不出来，点它不该有反应')
})

test('两处调用同一份渲染：聊天预览 + 设置页回滚卡预览（源级）', () => {
  const dialog = readFileSync(DIALOG, 'utf8')
  const card = readFileSync(CARD, 'utf8')
  assert.match(dialog, /<RollbackFileChanges/, '聊天预览必须用共享清单')
  assert.match(dialog, /renderFileIcon=\{renderFileIcon\}/, '聊天侧必须把外部图标来源传下去')
  assert.match(dialog, /onView: view,/, '聊天侧点文件名必须走同一个 view()（唯一打开入口）')
  assert.match(dialog, /readRollbackPreviewRemovals\(/, '聊天侧删除行必须取自引擎的删除集 removals')
  assert.doesNotMatch(dialog, /css\.rollbackFileList/, '聊天侧不得再自己画一份清单')
  // 设置页回滚卡：同一份渲染 + 同一对读法 + 同一个查看通道（内嵌差异面板）
  assert.match(card, /<RollbackFileChanges/, '设置页回滚卡必须用共享清单')
  assert.match(card, /readRollbackPreviewFiles\(preview\?\.workspace\)/, '清单必须取自引擎 preview.workspace.files')
  assert.match(card, /readRollbackPreviewRemovals\(preview\?\.workspace\)/, '删除行必须取自引擎的删除集 removals')
  assert.match(card, /rollbackPreviewScope\(previewFiles, previewRemovals\)/, '汇总必须走 ui 层唯一实现（口径与文件行同源）')
  assert.match(card, /view=\{fileView\}/, '查看通道必须显式接上（宿主没能力时不给假入口）')
  assert.match(card, /RollbackDiffPane state=\{inlineDiff\.state\}/, '设置页没有右侧栏：差异必须在弹窗内画出来')
  assert.match(card, /css\.planScroll/, '几百个文件的清单必须限高内滚')
  assert.doesNotMatch(card, /rollbackPreviewRows\(/, '预览弹窗不再画工作区/会话计数面板（与聊天预览同一屏）')
})

test('差异表全量渲染：渲染层不再有行数上限，也不再有「只画了前 N 行」话术（源级，2026-10-15）', () => {
  const table = readFileSync(TABLE, 'utf8')
  assert.doesNotMatch(table, /DIFF_ROW_CAP|rowCap|truncatedNotice/, '渲染层不得再留行数上限（用户 2026-10-15：我需要能完整的加载）')
  assert.match(table, /group\.rows\.map\(/, '每个块的行必须全部画出来')
  const pane = readFileSync(PANE, 'utf8')
  assert.doesNotMatch(pane, /truncatedNotice/, '回滚预览不再传截断文案')
  assert.match(pane, /rollback\.diff\.degraded/, '「整块替换」提示保留：那是算法保真度的事实，不是渲染截断')
  const plan = readFileSync(PLAN, 'utf8')
  assert.doesNotMatch(plan, /truncatedNotice/, '恢复计划不再传截断文案')
  for (const file of [RECOVERY_LOCALES, CLIENT_LOCALES]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /diffTruncated|diff\.truncated/, '截断话术必须删除：没有上限就不该留这句话')
  }
})

test('差异表文件头：只画路径文字，不画文件类型图标（源级，2026-10-14 用户第 2 次改口径）', () => {
  const table = readFileSync(TABLE, 'utf8')
  assert.doesNotMatch(table, /diffFileIcon/, '文件头不再有图标格子')
  assert.doesNotMatch(table, /icon\?: ReactNode/, '共享原语不再收图标节点（那颗链整个撤掉）')
  assert.match(table, /className=\{css\.diffFilePath \+ ' ' \+ css\.mono\}/, '路径文字仍是文件头的唯一内容')
  const pane = readFileSync(PANE, 'utf8')
  assert.doesNotMatch(pane, /RollbackFileIcon/, '差异面板不再引文件类型图标')
  assert.doesNotMatch(pane, /renderFileIcon/, '差异面板不再收外部图标来源')
})

test('侧栏标签页吃满宿主高度：不再自带一道 vh/px 上限（源级）', () => {
  const tab = readFileSync(TAB, 'utf8')
  assert.match(tab, /title=\{target\.path\} fill \/>/, '侧栏标签页：撑满那一屏')
  const dialog = readFileSync(DIALOG, 'utf8')
  assert.match(dialog, /<RollbackDiffPane state=\{inlineDiff\.state\} rt=\{rt\} title=\{inlineDiff\.path\} \/>/, '弹窗内的降级通道照旧画差异')
  assert.doesNotMatch(dialog, /RollbackDiffPane[^>]*\bfill\b/, '弹窗内的就地差异不给 fill（宿主面板高度不是它那一屏）')
  const css = readFileSync(CSS, 'utf8')
  assert.match(css, /\.diffPaneFill \{[\s\S]{0,120}?height: 100%/, 'fill 档必须 height:100% 才谈得上「= 侧栏大小」')
  assert.match(css, /\.diffPaneFill \.diffScroll \{[\s\S]{0,200}?min-height: 0/, 'flex 链必须允许收缩，否则内容顶破父容器（min-height:auto 陷阱）')
  // 撑满档整块取出来判定（块里现在还要容下 flex:auto 的依据注释，按字符窗口量距离会被注释挤爆）
  const fillBlock = css.slice(css.indexOf('.diffPaneFill {'), css.indexOf('.diffPaneFill .diffScroll'))
  assert.match(fillBlock, /\bmargin: 0/, '撑满档必须归零外边距：否则 100% 之外多出 10px，宿主面板自己冒一条滚动条')
  // 行盒 = 12×1.5 + 上下 1px ⇒ 20px/行：845px 宽的侧栏里 24 行折成 35 个视觉行，22px 差一行就溢出
  assert.match(css, /\.diffCell \{[\s\S]{0,80}?padding: 1px 6px/, '差异单元格上下内边距必须是 1px（20px 行高才装得进侧栏那一屏）')
})
test('侧栏标签页吃满宿主高度：整块高度跟侧栏走（源级，2026-10-15）', () => {
  const css = readFileSync(CSS, 'utf8')
  // ① 正文限高必须排在「列表量级」那条**之后**：两条特异性同为 (0,2,0)，顺序决定胜负；
  //    写在前面时 min(80vh, 800px) 会盖掉它 —— 侧栏比它高时差异区就停在那儿，
  //    正是用户 2026-10-15 报的「预览高度不跟侧栏走」。
  const listCap = css.indexOf('.diffPane .diffScroll')
  const fillCap = css.indexOf('.diffPaneFill .diffScroll')
  assert.ok(listCap >= 0 && fillCap >= 0, '两条限高规则都必须存在')
  assert.ok(fillCap > listCap, 'fill 档的限高必须排在 .diffPane .diffScroll 之后（顺序决定胜负）')
  assert.doesNotMatch(css.slice(fillCap, fillCap + 400), /min\(80vh, 800px\)/, 'fill 档不得再吃列表量级的 min(80vh, 800px) 上限')
  // ② 撑满档下**每个出口**都要套同一个整块容器：只让「就绪且有差异」撑满时，
  //    加载 / 一致 / 看不了 / 读失败会缩成一行，一屏高度来回跳（同样是「高度不跟侧栏走」）。
  const pane = readFileSync(PANE, 'utf8')
  assert.equal([...pane.matchAll(/return shell\(/g)].length, 6, '加载 / 读失败 / 结构化拒绝 / 看不了 / 不会改动 / 一致 六个出口都要经同一个撑满容器')
  assert.match(pane, /fill === true \? <div className=\{css\.diffPane \+ ' ' \+ css\.diffPaneFill\}>/, '撑满容器必须是 .diffPane + .diffPaneFill 那一对类名')
})

test('标签页芯片：[文件类型图标][文件名]，只经 title 位注册（源级）', () => {
  const tab = readFileSync(TAB, 'utf8')
  assert.match(tab, /export function RollbackDiffTabTitle/, '芯片必须是独立组件（正文位与芯片位两份注册）')
  assert.match(tab, /className=\{css\.rollbackTabIcon\} aria-hidden="true"/, "芯片图标必须有独立格子且是装饰性的（可访问名由文件名文字承担）")
  assert.match(tab, /<RollbackFileIcon path=\{target\.path\} size=\{14\} render=\{fileIcon\} \/>/, '芯片图标走共享的文件类型图标（与 DSH 侧栏同一画法）')
  assert.match(tab, /if \(target === null\) return/, '地址读不出来时退回宿主给的标题文字（不空着、也不自己编名字）')
  const index = readFileSync(PROXY, 'utf8')
  assert.match(index, /ROLLBACK_DIFF_TITLE_SLOT/, '装配点必须注册芯片位（宿主的 tab 定义没有 icon 字段）')
  assert.match(index, /name: ROLLBACK_DIFF_TITLE_SLOT,[\s\S]{0,80}?key: ROLLBACK_DIFF_TAB_ID/, '芯片位必须按正文同一个实现 id 注册（同一个 tab 才认领得到）')
  const css = readFileSync(CSS, 'utf8')
  assert.match(css, /\.rollbackTabIcon \{[\s\S]{0,160}?margin-right: 6px/, '芯片图标与文件名之间要有间距（与 better-sidebar 的 chipIcon 同档）')
})
