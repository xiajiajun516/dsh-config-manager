/**
 * 宿主接线守卫（源码级）—— /export-preview 必须把**失败分区的精确 id 列表**回给客户端（t7）。
 *
 * 为什么用源码级断言：HTTP 路由层在纯函数/适配器单测里覆盖不到（单测直接调 adapter/exporter）。
 * 本仓库已有同类先例：tests/host/export-item-selection.test.ts、
 * tests/route/status-plugin-diagnostics.test.ts（「宿主 /status 必须真的挂上诊断位」）。
 *
 * 两条不可放宽的约束：
 *  1. **向后兼容**：既有 `sectionsFailed`（数字）语义与类型不变，新字段是**新增**而非替换 ——
 *     旧客户端忽略未知字段，照常按计数渲染「N 个分区导出失败已跳过」；
 *  2. 失败分区 id 必须真的逐分区收集（在 catch 里 push adapter.id），而不是只回一个数字。
 *
 * 已做变异验证：删掉 catch 里的 `failedSections.push(adapter.id)` 或响应里的 `failedSections,`
 * → 红灯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostSource = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'src/client/api.ts'), 'utf8');

/** 取某个路由声明之后的一段源码（路由块很长，取足以覆盖其 handler 的窗口）。 */
function routeBlock(marker: string, span: number): string {
  const start = hostSource.indexOf(marker);
  assert.ok(start > 0, `未找到路由：${marker}`);
  return hostSource.slice(start, start + span);
}

test('导出预览路由：逐分区收集失败分区 id 并随响应回传（t7）', () => {
  const block = routeBlock('path: API.exportPreview,', 6000);

  // 1) 声明失败分区 id 列表（与既有的 sectionsFailed 计数并存）
  assert.match(
    block,
    /const failedSections: SectionId\[\] = \[\]/,
    '必须声明 failedSections: SectionId[] 收集失败分区 id',
  );
  // 2) 逐分区失败时点名（catch 内）+ 计数照旧
  assert.match(block, /sectionsFailed \+= 1\s*\n\s*failedSections\.push\(adapter\.id\)/, 'catch 里必须 push 失败分区 id');
  // 3) 响应同时回传两个字段
  assert.match(block, /^\s*sectionsFailed,\s*$/m, '既有 sectionsFailed 字段必须保留（向后兼容）');
  assert.match(block, /^\s*failedSections,\s*$/m, '响应必须回传 failedSections');
});

test('导出预览响应类型：sectionsFailed 语义不变 + failedSections 为可选新增字段', () => {
  // 既有字段：数字、非可选（语义与类型都不改）
  assert.match(
    apiSource,
    /export interface ExportPreviewResponse \{[\s\S]*?\n\s*sectionsFailed: number;/,
    'sectionsFailed 必须仍是必填 number',
  );
  // 新增字段：可选（旧宿主/第三方实现不回该字段时类型仍成立 ⇒ 客户端可回退）
  assert.match(
    apiSource,
    /failedSections\?: SectionId\[\];/,
    'failedSections 必须是可选字段（否则旧宿主响应类型不成立）',
  );
});
