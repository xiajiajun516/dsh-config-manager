/**
 * SectionTitle 的 `action` 槽守卫（W5，2026-11-14）。
 *
 * 为什么需要这条：卡头要「标题 + 右侧动作」时，最省事的写法是调用方自己再拼一行
 * （历史上叫过 .recoveryHead 之类），于是同一页出现两套标题行 —— 字号、间距、图标基线各一套，
 * 下次改标题样式时只改到一半。口径固定为：需要标题行右侧动作时**只传 `action`**，
 * 由 SectionTitle 复用 .sectionTitleRow 的 flex 与 .statusSpacer 推尾，不新造容器类。
 *
 * 第二条判据是**纯增量**：不传 `action` 时 DOM 必须与旧版逐字一致（21 处既有调用点不受影响），
 * 所以分支必须是 `action !== undefined && …` 的条件渲染，不能无条件插一个空 `<span>`/占位节点。
 *
 * 第三条是需求级：恢复页（P-05）唯一的重新拉取入口就挂在这个槽上 —— 它要是被顺手删掉，
 * 面板就退回「只能切页/刷新浏览器才能更新」，而那次改动的 diff 看起来很干净。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI_PATH = 'src/client/common/ui.tsx';
const RECOVERY_PATH = 'src/client/recovery/RecoveryPanel.tsx';

/** 截出 SectionTitle 的函数体（到下一个顶层 `function` / `export function` 为止）。 */
function sectionTitleBody(): string {
  const src = readFileSync(UI_PATH, 'utf8');
  const at = src.indexOf('export function SectionTitle(');
  assert.ok(at >= 0, UI_PATH + ' 里找不到 SectionTitle');
  const next = src.slice(at + 1).search(/\n(export )?function /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

test('action 槽：props 可选、条件渲染、用共享 statusSpacer 推尾（不新造容器类）', () => {
  const src = readFileSync(UI_PATH, 'utf8')
  const body = sectionTitleBody();

  // 属性声明在 SectionTitleProps（函数体外），所以对整文件断言类型；渲染分支对函数体断言。
  assert.match(src, /\n  action\?: ReactNode\n/,
    'SectionTitleProps 必须声明可选的 action（不传即旧行为）')

  assert.match(body, /\{action !== undefined && \(\s*<>\s*<span className=\{css\.statusSpacer\} \/>\s*\{action\}\s*<\/>\s*\)\}/,
    'action 必须是条件渲染，且先渲共享的 statusSpacer 再渲 action（纯增量：不传时 DOM 逐字不变）')

  // 位置：动作必须在 .sectionTitleRow 内、标题 <h3> 之后 —— 放 subtitle 之后会另起一行
  // （视觉上回到两套标题行）。2026-11-14 起没有 info 槽（ⓘ 下线），标题行里只有标题与动作。
  const rowAt = body.indexOf('css.sectionTitleRow')
  const titleAt = body.indexOf('<h3')
  const actionAt = body.indexOf('{action !== undefined')
  const subtitleAt = body.indexOf('{subtitle !== undefined')
  assert.ok(rowAt >= 0 && titleAt > rowAt && actionAt > titleAt && subtitleAt > actionAt,
    'action 必须渲染在 .sectionTitleRow 内、<h3> 之后、subtitle 之前（不得另起一行）')
})

test('恢复页（P-05）把「刷新」挂在 SectionTitle 的 action 槽上，而不是自建卡头', () => {
  const src = readFileSync(RECOVERY_PATH, 'utf8')
  const at = src.indexOf('<SectionTitle')
  assert.ok(at >= 0, RECOVERY_PATH + ' 里找不到 SectionTitle')
  // 到与 <SectionTitle 同缩进的收尾 '/>' 为止（action 里还有自闭合标签，不能截到第一个 '/>'）
  const end = src.indexOf('\n      />', at)
  assert.ok(end > at, RECOVERY_PATH + ' 里 SectionTitle 没有收尾')
  const block = src.slice(at, end)

  assert.match(block, /action=\{/, '恢复页标题行必须传 action（唯一重新拉取入口）')
  assert.match(block, /t\(\s*'recovery\.refresh'\s*\)/, 'action 槽里必须是「刷新」，文案走字典键 recovery.refresh')
  assert.match(block, /onClick=\{load\}/, '刷新按钮必须真的重新加载（onClick={load}）')
  assert.doesNotMatch(src, /className=\{css\.recoveryHead\}/,
    '不得另建 .recoveryHead 之类的第二套标题行容器（走 SectionTitle 的 action 槽）')
})
