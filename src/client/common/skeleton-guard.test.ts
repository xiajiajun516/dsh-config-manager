/**
 * 骨架屏守卫（源码级、零依赖、只读）：2026-11-04 用户第二条 ——
 * 「删除骨架屏的所有关于加载的描述（如左下角的『加载中』），骨架屏只保留骨架」。
 *
 * 为什么值得一条守卫：可见文案是「二次反馈」——骨架已经说明正在加载，色块下面再写一行
 * 「加载中…」既与 Spinner 的措辞重复，又会在数据到达时消失（旧的抖动来源）。删掉之后**不许**
 * 再被『可访问性所以要可见文案』这类理由加回来：加载语义由外框的 role=status + aria-busy +
 * aria-label 承担，读屏照样播报，视觉上只剩骨架。
 *
 * 复现：`node --test src/client/common/skeleton-guard.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { stripJsComments } from '../../utils/bundle-scan.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SKELETON_FILE = 'src/client/common/Skeleton.tsx';
const HOME_FILE = 'src/client/home/HomePanel.tsx';
const STYLE_FILE = 'src/client/config-manager.module.css';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function mutate(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), '负向自检锚点未命中（源码改写后需同步守卫）：' + from);
  return text.replace(from, to);
}

/** 可见加载文案的违规扫描（骨架侧）。 */
function findVisibleLoadingTextViolations(source: string): string[] {
  const violations: string[] = [];
  if (source.includes('skeletonCaption')) violations.push('骨架不得渲染可见的 caption（用户要求：骨架只保留骨架）');
  if (!/aria-label=\{label\}/.test(source)) violations.push('骨架外框必须用 aria-label={label} 承担加载语义（删掉可见文案后这是唯一的读屏来源）');
  return violations;
}

test('t14-1 骨架不渲染可见加载文案（label 只做 aria-label）', () => {
  const code = stripJsComments(read(SKELETON_FILE), true, false);
  const violations = findVisibleLoadingTextViolations(code);
  assert.deepEqual(violations, [], '骨架的加载反馈不干净：\n' + violations.join('\n'));

  const withCaption = mutate(code, '      aria-label={label}', '      aria-label={label}\n    >{label}</div><div');
  assert.ok(findVisibleLoadingTextViolations(withCaption + 'skeletonCaption').length >= 1, '负向自检：把文案渲回可见位置必须报红');
  const noName = code.split('aria-label={label}').join('');
  assert.ok(findVisibleLoadingTextViolations(noName).length >= 1, '负向自检：删掉 aria-label 必须报红');
});

test('t14-2 样式表与首页不再留加载说明的落点', () => {
  const css = read(STYLE_FILE);
  assert.ok(!css.includes('.skeletonCaption'), '样式表里不应再有 .skeletonCaption 规则（骨架不渲染可见文案）');
  assert.ok(!css.includes('.activityLoadingNote'), '样式表里不应再有 .activityLoadingNote（列头不挂加载说明）');

  const home = stripJsComments(read(HOME_FILE), true, false);
  assert.ok(!home.includes('activityLoadingNote'), '首页列头不应再挂加载说明');
  assert.equal(home.includes('>{t(\'common.loading\')}<'), false, '首页不得把 common.loading 渲染成可见文本');
});
