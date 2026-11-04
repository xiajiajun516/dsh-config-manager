/**
 * 动效守卫（源码级、零依赖、只读）：2026-11-04 用户提的「按压回弹」与「勾形描边」两条。
 *
 * 钉住三件事（每条都带负向自检，删掉即红）：
 *  1. **按压回弹的两侧必须同时成立**：CSS 端 `\:active` 缩到 96%、松手用 `linear()` 弹簧曲线过冲
 *     再落回；JSX 端**外链按钮**（Button 的 href 分支渲染 `<a>`）必须打 `data-pressable` ——
 *     选择器是 `:is(button, [data-pressable])`，属性没人写就等于外链按钮永远没有按压反馈。
 *     这条是实测发现的漂移（CSS 写了、JSX 漏了），所以两侧一起钉。
 *  2. **勾形描边的落点**：勾不是原生 UA 画的（原生 checkbox 只有一次淡入，::before/::after
 *     画不进去），而是 `appearance:none` + SVG mask 当笔画 + `clip-path` 从左往右揭开；
 *     柱子必须有显式 `box-sizing: border-box`（本仓库没有全局 `*{box-sizing}` 复位）。
 *  3. **reduced-motion 的终态**：关掉动画后**必须补上揭开的终态** clip-path，否则勾形永远是
 *     裁掉的样子（勾选框看起来全空）。这是「减法动画」最容易踩的坑，单列一条钉住。
 *
 * 复现：`node --test src/client/css-motion-guard.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { stripJsComments } from '../utils/bundle-scan.ts';

/** 仓库根（本文件位于 <root>/src/client/）。 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const STYLE_FILE = 'src/client/config-manager.module.css';
const UI_FILE = 'src/client/common/ui.tsx';

/** 读取即折 LF（issue #70 同口径：锚点全是含 \n 的源码字面量）。 */
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

/** 负向自检的改写：锚点必须命中（源码改了要同步守卫，而不是静默绿灯）。 */
function mutate(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), '负向自检锚点未命中（源码改写后需同步守卫）：' + from);
  return text.replace(from, to);
}

/** 取一条选择器规则的声明块（含嵌套花括号也要正确闭合）。 */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 所有 reduced-motion 媒体块的正文。
 * 为什么是复数：样式表里有多个 `@media (prefers-reduced-motion: reduce)` 块（历史遗留 + 本次追加），
 * 只取第一处会让守卫看漏（第一处恰是 `.taskPanel`，与本次改动无关）。
 */
function reducedMotionBodies(css: string): string[] {
  const out: string[] = [];
  const needle = '@media (prefers-reduced-motion: reduce)';
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at === -1) break;
    const body = ruleBody(css.slice(at), needle);
    if (body !== null) out.push(body);
    from = at + needle.length;
  }
  return out;
}

/** reduced-motion 违规扫描：关动画的同时必须补终态。 */
function findReducedMotionViolations(css: string): string[] {
  const bodies = reducedMotionBodies(css).join('\n');
  if (bodies === '') return ['缺少 @media (prefers-reduced-motion: reduce) 块'];
  const violations: string[] = [];
  if (!/:is\(button, \[data-pressable\]\):not\(:disabled\):active\s*\{[^}]*transform:\s*none/.test(bodies)) {
    violations.push('reduced-motion 下必须关掉按压缩放（transform: none）');
  }
  const checked = ruleBody(bodies, ".section input[type='checkbox']:checked::after {");
  if (checked === null) {
    violations.push('reduced-motion 下必须单独处理勾选态');
    return violations;
  }
  if (!/animation:\s*none/.test(checked)) violations.push('reduced-motion 下必须关掉描边动画');
  if (!/clip-path:\s*inset\(0 0 0 0\)/.test(checked)) {
    violations.push('reduced-motion 下必须补上「全部露出」的终态（只关 animation 会让勾形永远被裁掉）');
  }
  return violations;
}

/** 按压回弹违规扫描（CSS 侧）。 */
function findPressCssViolations(css: string): string[] {
  const violations: string[] = [];
  if (!/--cm-press-spring:\s*linear\(/.test(css)) {
    violations.push('缺少 --cm-press-spring: linear(…) —— 三次贝塞尔的过冲在按钮尺寸上肉眼无感，只能用 linear() 的 >1 进度');
  }
  const base = ruleBody(css, '.section :is(button, [data-pressable]) {');
  if (base === null) {
    violations.push('缺少按压回弹的基础规则 .section :is(button, [data-pressable])');
  } else {
    if (!/transition-property:[^;]*transform/.test(base)) violations.push('基础规则必须把 transform 放进 transition-property（否则缩放是瞬跳）');
    if (!/transition-timing-function:[^;]*--cm-press-spring/.test(base)) violations.push('松手必须用 --cm-press-spring（弹簧过冲的来源）');
    // 三色过渡不能被顶掉：简写会整体覆盖列表，这里要求列表里同时有颜色与 transform
    if (!/transition-property:[^;]*background-color/.test(base) || !/transition-property:[^;]*color/.test(base)) {
      violations.push('transform 必须并进三色过渡的列表，不得用 transition 简写顶掉 hover 变色');
    }
  }
  const active = ruleBody(css, '.section :is(button, [data-pressable]):not(:disabled):active {');
  if (active === null) {
    violations.push('缺少 :active 规则（按下时的缩小态）');
  } else {
    if (!/transform:\s*scale\(0\.96\)/.test(active)) violations.push(':active 必须缩到 scale(0.96)（用户要求 96%）');
    if (!/transition-timing-function:[^;]*ease-out/.test(active)) violations.push(':active 的 transform 必须回到 ease-out（跟手、不飘）');
  }
  return violations;
}

test('t13-1 按压回弹：按到 96%、松手弹簧过冲（CSS 侧的曲线与档位）', () => {
  const css = read(STYLE_FILE);
  const violations = findPressCssViolations(css);
  assert.deepEqual(violations, [], '按压回弹的样式不完整：\n' + violations.join('\n'));

  const noScale = mutate(css, '  transform: scale(0.96);', '  transform: none;');
  assert.ok(findPressCssViolations(noScale).length >= 1, '去掉 96% 缩放必须报红');
  const noSpring = mutate(css, 'transition-timing-function: ease, ease, ease, var(--cm-press-spring);', 'transition-timing-function: ease;');
  assert.ok(findPressCssViolations(noSpring).length >= 1, '松手不用弹簧曲线必须报红');
  const shorthand = mutate(
    css,
    '  transition-property: background-color, border-color, color, transform;\n  transition-duration: var(--cm-motion-fast), var(--cm-motion-fast), var(--cm-motion-fast), var(--cm-motion-base);\n  transition-timing-function: ease, ease, ease, var(--cm-press-spring);',
    '  transition: transform var(--cm-motion-base) var(--cm-press-spring);',
  );
  assert.ok(findPressCssViolations(shorthand).length >= 1, '退回 transition 简写（会顶掉 hover 变色）必须报红');
});

/** Button 的 href 分支渲染出的 `<a>` 开标签原文（找不到返回 null）。 */
function anchorTagOf(ui: string): string | null {
  const branch = ui.indexOf('if (href !== undefined) {');
  if (branch === -1) return null;
  const start = ui.indexOf('<a', branch);
  if (start === -1) return null;
  const end = ui.indexOf('>', start);
  if (end === -1) return null;
  return ui.slice(start, end + 1);
}

test('t13-2 外链按钮必须打 data-pressable（选择器靠属性入队，漏写就没有按压反馈）', () => {
  const ui = stripJsComments(read(UI_FILE), true, false);
  const tag = anchorTagOf(ui);
  assert.ok(tag !== null, UI_FILE + ' 里找不到 Button 的 href 分支渲染的 <a>（守卫需同步）');
  assert.ok(
    tag.includes('data-pressable'),
    '外链按钮必须带 data-pressable=""（CSS 的按压选择器只认 button 与该属性）：' + tag.replace(/\s+/g, ' '),
  );
  // 负向自检：删掉属性后同一条判据必须红
  const stripped = mutate(ui, '        data-pressable=""\n', '');
  const strippedTag = anchorTagOf(stripped);
  assert.ok(strippedTag !== null && !strippedTag.includes('data-pressable'), '负向自检：删掉属性后必须判定为缺属性');
});

/** 勾形描边违规扫描（自绘 + 笔画方向 + 播放时机）。 */
function findCheckStrokeViolations(css: string): string[] {
  const violations: string[] = [];
  const base = ruleBody(css, ".section input[type='checkbox'] {");
  if (base === null) {
    violations.push('缺少勾选框自绘的基础规则 input[type=checkbox]');
  } else {
    if (!/appearance:\s*none/.test(base)) violations.push('必须 appearance:none 接管原生勾选框（原生只有一次淡入，画不出描边）');
    if (!/box-sizing:\s*border-box/.test(base)) violations.push('必须显式 box-sizing:border-box（仓库没有全局 *{box-sizing} 复位）');
  }
  const mark = ruleBody(css, ".section input[type='checkbox']::after {");
  if (mark === null) {
    violations.push('缺少 ::after 的勾形');
  } else {
    if (!/mask-image:\s*url\("data:image\/svg\+xml/.test(mark)) violations.push('勾形必须是 SVG 笔画 mask（不是字符、不是第二张图）');
    if (!/clip-path:\s*inset\(0 100% 0 0\)/.test(mark)) violations.push('未勾选时必须整条裁掉（起点 = 左下起笔）');
  }
  if (!/@keyframes checkStroke\s*\{[\s\S]*?from\s*\{[^}]*clip-path:\s*inset\(0 100% 0 0\)[\s\S]*?to\s*\{[^}]*clip-path:\s*inset\(0 0 0 0\)/.test(css)) {
    violations.push('checkStroke 必须从「整条裁掉」到「全部露出」——即从左往右一路画过去');
  }
  const checked = ruleBody(css, ".section input[type='checkbox']:checked::after {");
  if (checked === null || !/animation:\s*checkStroke/.test(checked)) violations.push('勾选态必须播放 checkStroke');
  else if (!/animation:\s*checkStroke\s+var\(--cm-motion-draw\)/.test(checked)) {
    // 用户实测（2026-11-04 第二条）：「没有动画或者太快」—— 180ms 的 base 在 16px 方框上只是一闪。
    violations.push('勾选态必须用 --cm-motion-draw 播描边（base 的 180ms 太快，读不出笔画移动）');
  } else if (!/var\(--cm-motion-draw\)\s+var\(--cm-motion-ease-draw\)/.test(checked)) {
    // 缓动也是观感的一部分：ease-out 前 60ms 就画完 82%（仍像瞬间出现），ease-in-out 前 60ms 只有 6%（像先卡住）。
    violations.push('勾选态必须用 --cm-motion-ease-draw（通用缓动的前段进度不适合「画」，实测要么一闪要么先卡住）');
  }
  const draw = /--cm-motion-draw:\s*(\d+)ms;/.exec(css);
  if (draw === null) {
    violations.push('--cm-motion-draw 必须定义在 body 上（缺定义 ⇒ 时长在 computed-value 阶段失效，动画静默不播）');
  } else if (Number(draw[1]) < 300) {
    violations.push('--cm-motion-draw 至少 300ms（用户实测 180ms 太快）');
  }
  if (!/--cm-motion-ease-draw:\s*cubic-bezier\(/.test(css)) {
    violations.push('--cm-motion-ease-draw 必须以 cubic-bezier(…) 定义在 body 上');
  }
  return violations;
}

test('t13-3 勾选框自绘 + 勾形从左下画到右上（mask 笔画 + 左→右揭开）', () => {
  const css = read(STYLE_FILE);
  const violations = findCheckStrokeViolations(css);
  assert.deepEqual(violations, [], '勾形描边不完整：\n' + violations.join('\n'));

  const noAppearance = mutate(css, '  appearance: none;\n  box-sizing: border-box;', '  box-sizing: border-box;');
  assert.ok(findCheckStrokeViolations(noAppearance).length >= 1, '负向自检：退回原生勾选框必须报红');
  const noReveal = mutate(css, '    clip-path: inset(0 100% 0 0);\n  }\n  to {', '  }\n  to {');
  assert.ok(findCheckStrokeViolations(noReveal).length >= 1, '负向自检：描边起点不裁掉必须报红');
  const tooFast = mutate(css, '  animation: checkStroke var(--cm-motion-draw)', '  animation: checkStroke var(--cm-motion-base)');
  assert.ok(findCheckStrokeViolations(tooFast).length >= 1, '负向自检：退回 180ms 的 base 必须报红');
  const genericEase = mutate(css, 'var(--cm-motion-draw) var(--cm-motion-ease-draw)', 'var(--cm-motion-draw) var(--cm-motion-ease-out)');
  assert.ok(findCheckStrokeViolations(genericEase).length >= 1, '负向自检：改用通用 ease-out 必须报红');
  const noToken = mutate(css, '  --cm-motion-draw: 340ms;', '  --cm-motion-draw: 150ms;');
  assert.ok(findCheckStrokeViolations(noToken).length >= 1, '负向自检：描边时长低于 300ms 必须报红');
});

test('t13-4 reduced-motion：关动画必须补终态（否则勾形永远看不见）', () => {
  const css = read(STYLE_FILE);
  const violations = findReducedMotionViolations(css);
  assert.deepEqual(violations, [], 'reduced-motion 的终态不完整：\n' + violations.join('\n'));

  const broken = mutate(css, '    animation: none;\n    clip-path: inset(0 0 0 0);\n  }', '    animation: none;\n  }');
  assert.ok(findReducedMotionViolations(broken).length >= 1, '负向自检：去掉勾形终态必须报红');
  const noPress = mutate(css, '    transform: none;\n  }', '  }');
  assert.ok(findReducedMotionViolations(noPress).length >= 1, '负向自检：reduced-motion 下留着按压缩放必须报红');
});
