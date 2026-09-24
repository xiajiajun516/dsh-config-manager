/**
 * t49 结构护栏：MyConfigsView 的四个 render 段必须保持「已物理拆分」的状态。
 *
 * 本仓库刻意不引 React 组件测试框架（AGENTS.md：无组件框架，逻辑提炼到 src/ui/ 保证可测），
 * 所以这里用最小的 fs 结构断言守护**拆分边界**本身：
 *  - 四个子组件文件存在且各自导出对应组件（命名可核对）；
 *  - 主文件仍装配这四个子组件，且不再内联它们的 JSX 特征（防止重新长回千行单体）；
 *  - 行数预算：主文件 < 950 行、每个子组件 < 320 行（t49 拆分后实测 823 / 99 / 252 / 120 / 92）。
 * 特征串刻意取「只属于该段」的 CSS 类名 / 文案 key / 组件名：改动拆分边界时本测试会提醒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const lines = (name: string): number => read(name).replace(/\n$/, '').split('\n').length;

const MAIN = 'MyConfigsView.tsx';

/** 每段：文件名 + 导出组件名 + 只属于该段的特征串（正例：子组件里必须在；反例：主文件里必须没有） */
const PARTS: readonly { file: string; component: string; markers: readonly string[] }[] = [
  { file: 'MyConfigsLoginCard.tsx', component: 'MyConfigsLoginCard', markers: ['renderDeviceCode', 'myconfigs.login.userCode'] },
  { file: 'MyConfigsWizard.tsx', component: 'MyConfigsWizard', markers: ['css.hiddenFile', 'css.radioLabel', 'Modal.Body'] },
  { file: 'MyConfigsList.tsx', component: 'MyConfigsList', markers: ['css.snapshotList', 'css.rowActions'] },
  { file: 'MyConfigsInstall.tsx', component: 'MyConfigsInstall', markers: ['marketDetailView(', 'detailView.canImport'] },
];

test('t49：四个 render 段各自住在平铺子组件文件里（命名可核对）', () => {
  for (const part of PARTS) {
    const src = read(part.file);
    assert.ok(src.includes(`export function ${part.component}(`), `${part.file} 应导出 ${part.component}`);
    for (const marker of part.markers) {
      assert.ok(src.includes(marker), `${part.file} 应包含本段特征 ${marker}`);
    }
  }
});

test('t49：主文件只装配 —— 引用四个子组件，且不再内联它们的 JSX 特征', () => {
  const main = read(MAIN);
  for (const part of PARTS) {
    assert.ok(main.includes(`from './${part.file}'`), `${MAIN} 应 import ${part.file}`);
    assert.ok(main.includes(`<${part.component}`), `${MAIN} 应装配 <${part.component}>`);
    for (const marker of part.markers) {
      assert.ok(!main.includes(marker), `${MAIN} 不应再内联已迁出段的特征 ${marker}`);
    }
  }
  // 迁出后主文件不再需要这些依赖（Modal 属向导、MarketImportReview 属装回本地、effectiveImportSelection 属 ui 层）
  assert.ok(!main.includes("from '../common/Modal.tsx'"), `${MAIN} 不应再直接 import Modal`);
  assert.ok(!main.includes("from './MarketImportReview.tsx'"), `${MAIN} 不应再直接 import MarketImportReview`);
});

test('t49：行数预算（主文件 < 950 行；子组件 < 320 行）', () => {
  assert.ok(lines(MAIN) < 950, `${MAIN} 行数应远低于拆分前的 1151 行`);
  for (const part of PARTS) {
    assert.ok(lines(part.file) < 320, `${part.file} 不应长成新的单体组件`);
  }
});
