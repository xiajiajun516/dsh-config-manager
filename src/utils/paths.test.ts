/**
 * core-F4 回归：Windows 形状路径的前缀映射必须**折叠大小写**比较。
 *
 * 现象（audit-core core-F4）：手工路径映射里 oldPrefix 与真实值只差大小写时，逐字比较静默失配 →
 * 目标机保留源机绝对路径（workspace.path 与会话 cwd 对不上）。根因 = src/utils/paths.ts 的
 * applyPrefixMappings（core 侧调用点 analyzer 不变）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyPrefixMappings, isPathInside, isSameOrChild } from './paths.ts';
import type { PathMapping } from '../core/types.ts';

/** 测试用映射（appliesTo 与语义无关，任选一个合法分区） */
function mapping(oldPrefix: string, newPrefix: string): PathMapping {
  return { oldPrefix, newPrefix, appliesTo: ['workspaces'] };
}

function pathOf(value: unknown): string {
  return (value as { workspace: { path: string } }).workspace.path;
}

test('core-F4：Windows 路径大小写不一致的前缀映射必须照样生效（不得静默保留源机路径）', () => {
  // ① 子路径命中（反斜杠形态，大小写全不一致）
  const backslash = applyPrefixMappings(
    { workspace: { path: 'C:\\Users\\Alice\\Proj\\sub\\a.ts' } },
    [mapping('c:\\users\\alice\\proj', 'D:\\Data\\Proj')],
  );
  assert.equal(pathOf(backslash), 'D:/Data/Proj/sub/a.ts');

  // ② 整串相等（只差大小写）
  const exact = applyPrefixMappings(
    { workspace: { path: 'C:/Users/Alice/Proj' } },
    [mapping('c:/users/alice/proj', 'E:/moved')],
  );
  assert.equal(pathOf(exact), 'E:/moved');

  // ③ 正斜杠形态（归一化后同一判据）
  const forward = applyPrefixMappings(
    { workspace: { path: 'c:/Users/ALICE/proj/sub' } },
    [mapping('C:/users/alice/PROJ', 'F:/x')],
  );
  assert.equal(pathOf(forward), 'F:/x/sub');

  // ④ UNC 形态同样折叠
  const unc = applyPrefixMappings(
    { workspace: { path: '//Server/Share/Proj/x.ts' } },
    [mapping('//server/share/proj', '//Other/Share')],
  );
  assert.equal(pathOf(unc), '//Other/Share/x.ts');
});

test('core-F4：POSIX 路径**不得**折叠大小写（不同目录不许误匹配），逐字匹配行为不变', () => {
  const mappings: PathMapping[] = [mapping('/home/Alice/proj', '/srv/proj')];
  // 大小写不同 = 不同目录 → 原样保留
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/alice/proj/x' } }, mappings)), '/home/alice/proj/x');
  // 一致 → 照常映射（既有行为）
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj/x' } }, mappings)), '/srv/proj/x');
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj' } }, mappings)), '/srv/proj');
  // 段边界仍然生效（/home/Alice/project 不得被 /home/Alice/proj 命中）
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/project/x' } }, mappings)), '/home/Alice/project/x');
  // 空映射 = 恒等
  assert.equal(pathOf(applyPrefixMappings({ workspace: { path: '/home/Alice/proj/x' } }, [])), '/home/Alice/proj/x');
});

/**
 * #8 越界判定收敛：四份同义守卫（paths / restore 的 isWithinHome / restore 的 isRealInside /
 * verify-recovery 的副本）合并为 isPathInside。三份旧实现用 `rel.startsWith('..')` 判越界，
 * 会把名字真叫 `..foo` 的兄弟目录误判成逃逸（path.relative('/a/b', '/a/b/..foo') === '..foo'）。
 */
test('core-E1：越界判定只有一份实现，且 `..foo` 这种合法兄弟目录不得被误判成逃逸', () => {
  const parent = path.resolve('sandbox', 'home');
  const inside = (...segs: string[]): string => path.resolve(parent, ...segs);
  const outside = path.resolve('sandbox', 'other');

  // ① 名字真叫 ..foo 的兄弟目录在 parent 之内 —— 旧实现（rel.startsWith('..')）在此误杀
  assert.equal(isPathInside(inside('..foo'), parent), true, '..foo 是子目录，不是 ..');
  assert.equal(isPathInside(inside('..foo', 'settings.yaml'), parent), true);

  // ② 等于父目录 / .. 折叠后仍在父目录内
  assert.equal(isPathInside(parent, parent), true);
  assert.equal(isPathInside(inside('a', '..', 'b'), parent), true);

  // ③ 真越界：.. 段本身、以 .. + 分隔符开头、完全在外
  assert.equal(isPathInside(inside('..'), parent), false);
  assert.equal(isPathInside(inside('..', 'other'), parent), false);
  assert.equal(isPathInside(outside, parent), false);

  // ④ 别名与正典同口径（既有调用点不必改语义）
  assert.equal(isSameOrChild(inside('..foo'), parent), true);
  assert.equal(isSameOrChild(inside('..', 'x'), parent), false);

  // ⑤ 大小写：缺省按平台（Windows 折叠、POSIX 不折叠），显式开关可覆盖
  assert.equal(isPathInside(parent.toUpperCase(), parent), process.platform === 'win32');
  assert.equal(isPathInside('/a/B', '/a/b', { foldCase: true }), true);
  // foldCase:false 只在 POSIX 生效：win32 的 path.relative 自己就折大小写（故此处结果仍 true）
  assert.equal(isPathInside('/a/B', '/a/b', { foldCase: false }), process.platform === 'win32');
});
