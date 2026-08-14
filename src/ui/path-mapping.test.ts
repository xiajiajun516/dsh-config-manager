/**
 * path-mapping 测试（m6-ui，规范 §12）：
 * 单项映射 + 批量前缀映射、preview 替换、toPathMappings 只含已解析、isComplete。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PathMappingEditor } from './path-mapping.ts';
import type { PathIssue } from '../core/types.ts';

const ISSUES: PathIssue[] = [
  { kind: 'missing', value: 'C:\\Users\\alice\\projects\\ops' },
  { kind: 'platformMismatch', value: 'C:\\Users\\alice\\projects\\dev' },
  { kind: 'missing', value: '/Users/alice/work' },
];

test('path-mapping: 从 issues 初始化草稿，全部未解析', () => {
  const ed = new PathMappingEditor({ issues: ISSUES });
  assert.equal(ed.all.length, 3);
  assert.equal(ed.unresolved.length, 3);
  assert.equal(ed.isComplete, false);
  assert.equal(ed.toPathMappings().length, 0);
});

test('path-mapping: 单项映射后 toPathMappings 只含已解析', () => {
  const ed = new PathMappingEditor({ issues: ISSUES });
  ed.setMapping('C:\\Users\\alice\\projects\\ops', 'D:\\data\\ops');
  const mappings = ed.toPathMappings();
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]!.oldPrefix, 'C:\\Users\\alice\\projects\\ops');
  assert.equal(mappings[0]!.newPrefix, 'D:\\data\\ops');
  assert.deepEqual(mappings[0]!.appliesTo, []);
  assert.equal(ed.unresolved.length, 2);
  assert.equal(ed.isComplete, false);
});

test('path-mapping: 批量前缀映射聚合到单条 draft', () => {
  const ed = new PathMappingEditor({ issues: ISSUES });
  ed.setMapping('C:\\Users\\alice\\', 'C:\\Users\\bob\\');
  const mappings = ed.toPathMappings();
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]!.oldPrefix, 'C:\\Users\\alice\\');
  // 三条 issue 中两条以该前缀开头 → 全部视为已解决；/Users/alice/work 未解决
  assert.equal(ed.unresolved.length, 1);
});

test('path-mapping: preview 用 applyPrefixMappings 替换', () => {
  const ed = new PathMappingEditor({ issues: ISSUES });
  ed.setMapping('C:\\Users\\alice\\', 'C:\\Users\\bob\\');
  assert.equal(ed.preview('C:\\Users\\alice\\projects\\ops'), 'C:/Users/bob/projects/ops');
  assert.equal(ed.preview('/Users/alice/work'), '/Users/alice/work');
});

test('path-mapping: 全部解决后 isComplete 为 true', () => {
  const ed = new PathMappingEditor({ issues: ISSUES });
  ed.setMapping('C:\\Users\\alice\\', 'C:\\Users\\bob\\');
  ed.setMapping('/Users/alice/work', '/home/bob/work');
  assert.equal(ed.isComplete, true);
  assert.equal(ed.toPathMappings().length, 2);
});

test('path-mapping: existing 预置映射可直接复用（oldPrefix 聚合）', () => {
  const ed = new PathMappingEditor({
    existing: [{ oldPrefix: 'C:\\Users\\alice\\', newPrefix: 'C:\\Users\\bob\\', appliesTo: ['workspaces', 'mcp'] }],
  });
  assert.equal(ed.resolved.length, 1);
  assert.deepEqual(ed.resolved[0]!.appliesTo, ['workspaces', 'mcp']);
});
