/**
 * 差异视图渲染模型（框架无关纯函数，node 可测）。
 *
 * 输入：utils/line-diff.ts 产出的 hunks（行级编辑脚本）
 * 输出：左右双栏对照所需的「行对」——左边=当前（before），右边=快照（after）。
 *
 * 对齐规则：上下文行两侧同一行；连续的删除块与新增块**按下标配对**成「修改行对」
 * （左红右绿），多出来的删除行只占左侧、多出来的新增行只占右侧。
 * 本层不产出文案（渲染层按 kind 决定样式与标题）。
 */
import type { DiffHunk, DiffLine } from '../utils/line-diff.ts';

/** 行对语义：context=未变 / change=成对修改 / del=仅删除（右侧空）/ add=仅新增（左侧空） */
export type SideKind = 'context' | 'change' | 'del' | 'add';

export interface SideBySideRow {
  kind: SideKind;
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface SideBySideHunk {
  /** unified 风格的块头（@@ -a,b +c,d @@） */
  header: string;
  rows: SideBySideRow[];
}

/** 块头文本（与 git unified diff 一致；UI 直接展示，不参与 i18n）。 */
export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

function rowsOfHunk(hunk: DiffHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.kind === 'context') {
      rows.push({ kind: 'context', left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === 'del') {
      const current = lines[i];
      if (current !== undefined) dels.push(current);
      i += 1;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]?.kind === 'add') {
      const current = lines[i];
      if (current !== undefined) adds.push(current);
      i += 1;
    }
    const pairs = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      const kind: SideKind = left !== null && right !== null ? 'change' : left !== null ? 'del' : 'add';
      rows.push({ kind, left, right });
    }
  }
  return rows;
}

/** hunks → 左右双栏渲染模型（每块带块头）。 */
export function toSideBySide(hunks: readonly DiffHunk[]): SideBySideHunk[] {
  return hunks.map((hunk) => ({ header: hunkHeader(hunk), rows: rowsOfHunk(hunk) }));
}

/**
 * 行号最大位数（双栏行号列宽的档位依据）：取实际渲染的行号里最长的那个，
 * 让行号列只占「最宽行号」需要的宽度，剩余空间全部留给代码列。
 */
export function maxLineDigits(hunks: readonly DiffHunk[]): number {
  let max = 1;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo !== null && line.oldNo > max) max = line.oldNo;
      if (line.newNo !== null && line.newNo > max) max = line.newNo;
    }
  }
  return String(max).length;
}

/** 行对总数（渲染层做「超长截断」提示时的分母）。 */
export function countSideRows(groups: readonly SideBySideHunk[]): number {
  return groups.reduce((sum, group) => sum + group.rows.length, 0);
}
