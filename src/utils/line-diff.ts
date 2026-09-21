/**
 * 行级文本 diff 内核（零依赖纯函数，node 可测）。
 *
 * 用途：为「恢复计划预览」等场景产出**左右双栏对照 / 统一格式**差异所需的
 * 行级编辑脚本（hunks）。只做行级比较（不做词级 / 字符级高亮），不读写文件、
 * 不产出任何文案 —— 文件读取与上限策略在 core 层（src/core/snapshot-diff.ts），
 * 渲染模型在 ui 层（src/ui/diff-view.ts）。
 *
 * 算法：先裁掉公共前缀 / 后缀（配置文件的 diff 通常极小，裁剪后变更区很小），
 * 剩余变更区用 Myers O((N+M)·D) 贪心算法求最短编辑脚本；变更规模超过预算
 * （maxLines / maxD）时**降级为整块替换**（全删 + 全增），保证任何输入都有确定
 * 耗时的输出 —— 大文件不会卡死宿主。
 *
 * 行为约定：
 *  - 行尾 \r\n 归一为 \n；文本末尾的换行不产生"空行"（行数 = 换行符语义）。
 *  - 仅空白差异同样是差异（不做 ignoreWhitespace）。
 *  - 完全一致时 hunks 为空、identical=true。
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 行内容（不含行尾换行） */
  text: string;
  /** 旧侧行号（1-based；新增行为 null） */
  oldNo: number | null;
  /** 新侧行号（1-based；删除行为 null） */
  newNo: number | null;
}

/** 连续变更块（含上下文），行号语义与 unified diff 的 @@ 头一致 */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** 两侧内容一致（无任何变更行） */
  identical: boolean;
  /** 因规模预算降级为「整块替换」（结果仍然正确，只是不是最小编辑脚本） */
  degraded: boolean;
}

export interface DiffOptions {
  /** 变更块外保留的上下文行数（缺省 3，与 git 一致） */
  context?: number;
  /** 参与 Myers 的变更区行数上限（两侧合计；超出 → 降级整块替换） */
  maxLines?: number;
  /** Myers 最大编辑距离 D（超出 → 降级整块替换） */
  maxD?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 6000;
const DEFAULT_MAX_D = 400;

/** 文本 → 行数组（CRLF 归一、尾换行不产生空行）。 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  // 末尾换行 = 最后一行已结束，split 产生的空尾元素不是一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type OpKind = 'context' | 'add' | 'del';
interface Op {
  kind: OpKind;
  text: string;
}

/** 变更区全部替换（降级路径：不做最小编辑脚本，但保证确定性耗时）。 */
function replaceAllOps(a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = [];
  for (const line of a) ops.push({ kind: 'del', text: line });
  for (const line of b) ops.push({ kind: 'add', text: line });
  return ops;
}

/** Myers 回溯：从 (n, m) 沿 trace 走回 (0, 0)，产出正序 ops。 */
function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], dMax: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dMax; d > 0; d -= 1) {
    const v = trace[d];
    if (v === undefined) break;
    const k = x - y;
    const idx = k + offset;
    const down = v[idx + 1] ?? 0;
    const right = v[idx - 1] ?? 0;
    const goDown = k === -d || (k !== d && right < down);
    const prevK = goDown ? k + 1 : k - 1;
    const prevX = v[prevK + offset] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'context', text: a[x - 1] ?? '' });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: 'add', text: b[y - 1] ?? '' });
      y -= 1;
    } else {
      ops.push({ kind: 'del', text: a[x - 1] ?? '' });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'context', text: a[x - 1] ?? '' });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    ops.push({ kind: 'del', text: a[x - 1] ?? '' });
    x -= 1;
  }
  while (y > 0) {
    ops.push({ kind: 'add', text: b[y - 1] ?? '' });
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/** Myers 贪心（O((N+M)·D)）；超出 maxD 返回 null 由调用方降级。 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const cap = Math.min(maxD, n + m);
  const offset = cap;
  const v = new Int32Array(2 * cap + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= cap; d += 1) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      let x: number;
      if (k === -d || (k !== d && (v[idx - 1] ?? 0) < (v[idx + 1] ?? 0))) {
        x = v[idx + 1] ?? 0;
      } else {
        x = (v[idx - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[idx] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

/** 组装带行号的完整行序列（前缀上下文 + 变更区 + 后缀上下文）。 */
function assemble(a: readonly string[], pre: number, suf: number, mid: readonly Op[]): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < pre; i += 1) {
    out.push({ kind: 'context', text: a[i] ?? '', oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  for (const op of mid) {
    if (op.kind === 'context') {
      out.push({ kind: 'context', text: op.text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (op.kind === 'del') {
      out.push({ kind: 'del', text: op.text, oldNo, newNo: null });
      oldNo += 1;
    } else {
      out.push({ kind: 'add', text: op.text, oldNo: null, newNo });
      newNo += 1;
    }
  }
  for (let i = a.length - suf; i < a.length; i += 1) {
    out.push({ kind: 'context', text: a[i] ?? '', oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  return out;
}

/** 按上下文窗口把行序列切成 hunks（相邻窗口重叠则合并）。 */
function toHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'context') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1);
    let oldStart: number | null = null;
    let newStart: number | null = null;
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < start; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.oldNo !== null) oldBefore += 1;
      if (line.newNo !== null) newBefore += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    for (const line of slice) {
      if (oldStart === null && line.oldNo !== null) oldStart = line.oldNo;
      if (newStart === null && line.newNo !== null) newStart = line.newNo;
      if (line.oldNo !== null) oldCount += 1;
      if (line.newNo !== null) newCount += 1;
    }
    return {
      oldStart: oldStart ?? oldBefore + 1,
      oldCount,
      newStart: newStart ?? newBefore + 1,
      newCount,
      lines: slice,
    };
  });
}

/**
 * 行级 diff：两段文本 → hunks + 行数统计。
 * 纯函数、无 I/O；超大输入请由调用方先行截断或改用 replaceAll（degraded 已覆盖）。
 */
export function diffLines(before: string, after: string, opts: DiffOptions = {}): DiffResult {
  const context = Math.max(0, opts.context ?? DEFAULT_CONTEXT);
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
  const maxD = Math.max(1, opts.maxD ?? DEFAULT_MAX_D);
  if (before === after) {
    return { hunks: [], added: 0, removed: 0, identical: true, degraded: false };
  }
  const a = splitLines(before);
  const b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);
  let degraded = false;
  let mid: Op[];
  if (aMid.length + bMid.length > maxLines) {
    degraded = true;
    mid = replaceAllOps(aMid, bMid);
  } else {
    const found = myers(aMid, bMid, maxD);
    if (found === null) {
      degraded = true;
      mid = replaceAllOps(aMid, bMid);
    } else {
      mid = found;
    }
  }
  const lines = assemble(a, pre, suf, mid);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
  }
  return { hunks: toHunks(lines, context), added, removed, identical: added === 0 && removed === 0, degraded };
}

/** 二进制探测：含 NUL 字节即视为二进制（与 git 同口径，只看前 8KB）。 */
export function looksBinary(text: string): boolean {
  const probe = text.slice(0, 8192);
  return probe.includes('\u0000');
}
