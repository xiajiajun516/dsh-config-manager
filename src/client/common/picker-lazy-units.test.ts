/**
 * 源码守卫（2026-10-12 用户反馈）：导出选择器里**未勾选的分区**也必须能展开、能逐项挑选。
 *
 * 根因：条目清单由导出页**逐分区惰性拉取**，且只预取「已勾选分区」—— 于是未勾选分区的 `units` 为空，
 * 组件据此既不渲染展开控件、又把计数渲染成「已选 0/0」，用户必须先勾上整个分区才能展开与挑选条目。
 * 修法：未读（`unitsUnread`）照常渲染展开控件，展开时才经 `onRequestUnits` 去读；未读不显示 0/0。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测）。
 * 两条判定本身由 src/ui/selection-model.test.ts 覆盖，这里只钉住「组件确实用了它、调用点确实接了线」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件位于 src/client/common/） */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PICKER = fs.readFileSync(path.join(ROOT, 'src/client/common/ContentPicker.tsx'), 'utf8')
const EXPORT = fs.readFileSync(path.join(ROOT, 'src/client/export/ExportView.tsx'), 'utf8')

test('选择器：未读分区照常渲染展开控件，展开时才按分区拉清单', () => {
  assert.ok(PICKER.includes('const expandable = sectionExpandable(node)'), '展开控件判据必须走 ui 纯函数 sectionExpandable');
  assert.ok(PICKER.includes('{expandable ? ('), '展开控件必须按 expandable 渲染（未读分区也要有它）');
  assert.ok(PICKER.includes('onRequestUnits?.(node.section)'), '展开未读分区必须触发按需读取');
  assert.ok(PICKER.includes('unitsUnread === true'), '只在「未读且即将展开」时请求（已读 / 收起不重复请求）');
  assert.ok(PICKER.includes('sectionCountState(node, {'), '计数区状态必须走 ui 纯函数 sectionCountState（未读不渲染 0/0）');
});

test('选择器：空白会话（从未提问）显示本地化占位名，不拿 uuid 当标题', () => {
  assert.ok(PICKER.includes("u.blank === true ? ("), '空白会话必须走占位名分支');
  assert.ok(PICKER.includes("t('picker.blankSession')"), '占位名必须走字典（禁止硬编码用户可见字符串）');
  assert.ok(PICKER.includes('title={safeLabel}'), '目录名仍进 title（悬停可核对是哪一条）');
});

test('导出页：未读到清单的分区标记 unitsUnread，展开动作接到按需读取', () => {
  assert.ok(EXPORT.includes('unitsUnread: got === undefined'), '未取到清单的分区必须标记为「未读」');
  assert.ok(
    EXPORT.includes('onRequestUnits={(id) => { void fetchInventory(couplingInventorySections([id])) }}'),
    '展开未读分区 → 按需读取（会话分区还要带上工作区清单：勾选联动的数据源在它身上）',
  );
});
