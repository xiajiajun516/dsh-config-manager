/**
 * patch 文档结构重建（issue #133）：顶层行 ≠ `- insert:` 块成员。
 *
 * 宿主合并循环里，顶层 `- id: X` 按 id **覆盖**（查不到就 `patch: entry "X" not found` 丢弃），
 * 只有 insert 块成员是**新增**。旧实现把所有行统一输出成顶层行 —— 一条 update 就把只能靠
 * insert 新增的条目（MCP server 最典型）在重启后整段作废。本文件钉住三条不变量：
 *   ① 既有 insert 成员更新后**归属不变**；② 新增（action:'insert'）落进 insert 块；
 *   ③ 任一 id 不得同时具备两种身份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describePatchDocument, describePatchLayoutDrift, PatchPromoteRefusedError, planPatchDocument,
} from './patch-document.ts';

const DOC = [
  { id: 'top-a', name: '@deepseek-ai/dsh-top', disabled: false },
  { insert: [
    { id: 'mcp-a', name: 'dsh-mcp-client', config: { transport: 'stdio', command: 'npx' } },
    { id: 'mcp-b', name: 'dsh-mcp-client', config: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' } },
  ] },
  { id: 'top-b', name: '@deepseek-ai/dsh-other' },
];

test('#133 insert 块保真：更新一条 insert 成员后仍留在块里，成员集合不变', () => {
  const plan = planPatchDocument(DOC, [
    { lineId: 'mcp-a', raw: { id: 'mcp-a', name: 'dsh-mcp-client', config: { transport: 'stdio', command: 'uvx' } }, action: 'update' },
  ]);
  assert.deepEqual(plan.insertIds, ['mcp-a', 'mcp-b']);
  assert.deepEqual(plan.topLevelIds, ['top-a', 'top-b']);
  const block = plan.items.find((item) => Array.isArray((item as Record<string, unknown>)['insert'])) as { insert: { id: string; config: { command: string } }[] };
  assert.ok(block !== undefined, 'insert 块必须仍然存在（旧实现会把它摊平成两条顶层行）');
  assert.deepEqual(block.insert.map((e) => e.id), ['mcp-a', 'mcp-b']);
  assert.equal(block.insert[0]?.config.command, 'uvx', '更新后的值写进块成员');
});

test('#133 顶层行更新不改归属（也不会掉进 insert 块）', () => {
  const plan = planPatchDocument(DOC, [
    { lineId: 'top-a', raw: { id: 'top-a', name: '@deepseek-ai/dsh-top', disabled: true }, action: 'update' },
  ]);
  assert.deepEqual(plan.topLevelIds, ['top-a', 'top-b']);
  assert.deepEqual(plan.insertIds, ['mcp-a', 'mcp-b']);
  assert.equal((plan.items[0] as { disabled: boolean }).disabled, true, '顶层行保持原位');
});

test('#133 新增条目走 insert 动作时落进 insert 块（新增语义，而不是覆盖）', () => {
  const plan = planPatchDocument(DOC, [
    { lineId: 'mcp-new', raw: { id: 'mcp-new', name: 'dsh-mcp-client', config: { transport: 'stdio', command: 'node' } }, action: 'insert' },
  ]);
  assert.deepEqual(plan.insertIds, ['mcp-a', 'mcp-b', 'mcp-new']);
  assert.deepEqual(plan.topLevelIds, ['top-a', 'top-b'], '新增绝不能出现在顶层行里');
});

test('#133 update 动作写新 id 时保持旧的 upsert 语义（顶层行，不改既有契约）', () => {
  const plan = planPatchDocument(DOC, [
    { lineId: 'plain', raw: { id: 'plain', disabled: true }, action: 'update' },
  ]);
  assert.deepEqual(plan.topLevelIds, ['top-a', 'top-b', 'plain']);
  assert.deepEqual(plan.insertIds, ['mcp-a', 'mcp-b']);
});

test('#133 remove 删掉 insert 成员后块仍保留其余成员', () => {
  const plan = planPatchDocument(DOC, [{ lineId: 'mcp-a', raw: null, action: 'remove' }]);
  assert.deepEqual(plan.insertIds, ['mcp-b']);
  const blocks = plan.items.filter((item) => Array.isArray((item as Record<string, unknown>)['insert']));
  assert.equal(blocks.length, 1);
});

test('#133 remove 删光 insert 成员后不留空块（空块会被宿主当空 insert）', () => {
  const plan = planPatchDocument(DOC, [
    { lineId: 'mcp-a', raw: null, action: 'remove' },
    { lineId: 'mcp-b', raw: null, action: 'remove' },
  ]);
  assert.deepEqual(plan.insertIds, []);
  assert.equal(plan.items.some((item) => Array.isArray((item as Record<string, unknown>)['insert'])), false);
  assert.deepEqual(plan.topLevelIds, ['top-a', 'top-b']);
});

test('#133 空文档 + insert 动作：落成 insert 块（MCP 从零新建的路径）', () => {
  const plan = planPatchDocument(undefined, [
    { lineId: 'first', raw: { id: 'first', name: 'dsh-mcp-client', config: { transport: 'stdio', command: 'npx' } }, action: 'insert' },
  ]);
  assert.deepEqual(plan.insertIds, ['first']);
  assert.deepEqual(plan.topLevelIds, []);
  assert.equal(plan.items.length, 1);
});

test('#133 同一 id 不得同时具备两种身份（防御性不变量）', () => {
  // 文档里同一 id 既在块里又在顶层：以首次出现为准，绝不产生「两种身份并存」的输出
  const plan = planPatchDocument([
    { insert: [{ id: 'dup', name: 'a' }] },
    { id: 'dup', name: 'b' },
  ], []);
  assert.deepEqual(plan.insertIds, ['dup']);
  assert.deepEqual(plan.topLevelIds, []);
  assert.equal(new PatchPromoteRefusedError(['x']).ids[0], 'x');
});

test('#133 写后自检：布局不一致时给出可读差异（一致返回 null）', () => {
  const planned = describePatchDocument(DOC);
  assert.equal(describePatchLayoutDrift(planned, describePatchDocument(DOC)), null);
  const drift = describePatchLayoutDrift(planned, { insertIds: [], topLevelIds: ['top-a', 'mcp-a', 'mcp-b', 'top-b'] });
  assert.ok(drift !== null);
  assert.match(String(drift), /insert=\[mcp-a, mcp-b\]/);
  assert.match(String(drift), /got insert=\[\]/);
});
