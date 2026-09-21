/**
 * t7：客户端消费 /export-preview 的**失败分区精确清单**（含向后兼容回退）。
 *
 * 背景：宿主原先只回 `sectionsFailed`（数字），客户端只能靠「请求了但没回来」推断是哪些
 * 分区读取失败；t7 起宿主额外回 `failedSections: SectionId[]`（可选字段）。
 * 本测试锁死两件事：
 *  1. 有精确清单时**消费它**（含宿主点名了「清单也回来了」的分区这种防御性情形）；
 *  2. **旧宿主**（无该字段）或宿主漏报时，回退到既有推断 —— 行为与改造前完全一致。
 *
 * 解析逻辑放在 API 层（`src/client/api.ts` 的 `resolveFailedSections`）而不是组件里，
 * 因此可以像这样直接 node 单测（AGENTS.md：组件不写可测试逻辑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFailedSections } from '../../src/client/api.ts';
import type { SectionId } from '../../src/schema/types.ts';

/** 构造响应片段（只包含解析函数用到的两个字段） */
function resp(sections: SectionId[], failedSections?: SectionId[]) {
  return {
    sections: sections.map((s) => ({ section: s, count: 0, sizeBytes: 0, items: [] })),
    ...(failedSections !== undefined ? { failedSections } : {}),
  };
}

const REQUESTED: SectionId[] = ['settings', 'plugins', 'sessions'];

test('t7 客户端：旧宿主（无 failedSections 字段）→ 回退到「请求了但没回来」的推断', () => {
  // 请求 3 个分区，只回来 2 个 → 没回来的那个是失败（与改造前完全一致）
  assert.deepEqual(resolveFailedSections(REQUESTED, resp(['settings', 'sessions'])), ['plugins']);
  // 全部回来 → 无失败（不得凭空标记，否则界面会误报「读取失败」）
  assert.deepEqual(resolveFailedSections(REQUESTED, resp(REQUESTED)), []);
});

test('t7 客户端：宿主回精确清单时被消费（顺序/去重跟随 requested）', () => {
  // 精确清单与「没回来」一致：结果相同
  assert.deepEqual(
    resolveFailedSections(REQUESTED, resp(['settings', 'sessions'], ['plugins'])),
    ['plugins'],
  );
  // 多个失败分区：顺序跟随 requested（UI 逐分区记账的稳定性），且不重复
  assert.deepEqual(
    resolveFailedSections(REQUESTED, resp(['sessions'], ['plugins', 'settings'])),
    ['settings', 'plugins'],
  );
  // 宿主点名了「清单也回来了」的分区：以点名者为准（保守标记失败，宁可提示不可隐瞒）
  assert.deepEqual(
    resolveFailedSections(REQUESTED, resp(REQUESTED, ['sessions'])),
    ['sessions'],
  );
  // 宿主明确回空清单：只要还有分区没回来，兜底推断仍标失败（不漏标）
  assert.deepEqual(
    resolveFailedSections(REQUESTED, resp(['settings', 'sessions'], [])),
    ['plugins'],
  );
});

test('t7 客户端：精确清单里不属于本次请求的 id 一律忽略（不越批标记）', () => {
  assert.deepEqual(
    resolveFailedSections(['settings'], resp(['settings'], ['sessions', 'plugins'])),
    [],
  );
  // 真正失败的分区仍被标记，越批 id 不进入结果
  assert.deepEqual(
    resolveFailedSections(['settings', 'sessions'], resp(['settings'], ['plugins', 'sessions'])),
    ['sessions'],
  );
});

test('t7 源码守卫：ExportView 只调用 API 层解析函数，组件内不再自己判定失败分区', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const view = fs.readFileSync(path.join(root, 'src/client/export/ExportView.tsx'), 'utf8');
  assert.match(view, /const failedNow = resolveFailedSections\(todo, result\)/, '必须调用 resolveFailedSections');
  assert.match(view, /^import \{ resolveFailedSections \} from '\.\.\/api\.ts'$/m, '必须从 api.ts 导入');
  assert.doesNotMatch(
    view,
    /failedSectionsFromResponse/,
    '组件内不得再自己判定失败分区（逻辑下沉到 API 层，node 可测）',
  );
});
