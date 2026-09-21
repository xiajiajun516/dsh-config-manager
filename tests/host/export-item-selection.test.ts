/**
 * 宿主接线守卫（源码级）—— 条目级导出选择（Phase 1）的接线**不能丢**。
 *
 * 为什么用源码级断言：这两处接线（路由解析 includeItems、预览返回条目明细）在纯函数与
 * 适配器单测里都覆盖不到 —— 单测直接调 adapter/exporter，绕过 HTTP 层。本仓库已有同类
 * 先例（`src/core/model-tools.test.ts` 的「宿主 /status 必须真的挂上诊断位」守卫）。
 *
 * 另一条不可放宽的语义：**脏 body 绝不能静默缩小导出范围**（宁可多导，不可少导）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

/** 取某个路由声明之后的一段源码（路由块很长，取足以覆盖其 handler 的窗口）。 */
function routeBlock(marker: string, span: number): string {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `未找到路由：${marker}`);
  return source.slice(start, start + span);
}

test('导出路由：解析 includeItems 且过滤后为空的白名单一律忽略', () => {
  const block = routeBlock('path: API.export,', 9000);
  assert.match(block, /const includeItems: Partial<Record<SectionId, string\[\]>> = \{\}/);
  // 非法/空白名单必须被丢弃（回落该分区全量），否则脏 body 会静默缩小导出范围
  assert.match(block, /if \(ids\.length > 0\) includeItems\[key as SectionId\] = ids/);
  assert.match(block, /Object\.keys\(includeItems\)\.length > 0 \? \{ includeItems \}/);
});

test('导出预览路由：返回条目明细（adapter.listUnits 零 I/O 派生）', () => {
  const block = routeBlock('path: API.exportPreview,', 6000);
  assert.match(block, /adapter\.listUnits\?\.\(section\)/);
  assert.match(block, /items/);
  // 单元枚举失败不得拖垮整个预览（退化为「不可细分」，用户仍能整分区导出）
  assert.match(block, /catch \{/);
});
