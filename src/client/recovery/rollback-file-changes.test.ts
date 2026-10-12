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
