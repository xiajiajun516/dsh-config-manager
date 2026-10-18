/**
 * m-sync-flow：行级文本三方合并 + 递归 JSON 结构化合并（零依赖纯函数）。
 *
 * 职责边界（本文件只做纯计算：不读配置、不落盘、不打日志）：
 *  - looksLikeText / tryParseJson：内容形态判定（文本 / JSON）；
 *  - mergeJsonValues：JSON 值级递归三方合并（对象按 key 递归；数组绝不按索引合并）；
 *  - mergeTextThreeWay：文本级三方合并（三段都是合法 JSON 时优先走结构化合并）；
 *  - mergeBytesThreeWay：字节级入口，非文本 / 超限 / 缺祖先一律如实拒绝（绝不猜）。
 *
 * 安全口径（改这里前先读）：
 *  - 冲突优先于猜测：语义不明的合并（数组双侧改动、同一区域双侧改动、类型互换）一律报冲突，
 *    绝不静默丢弃任一侧的键 / 插件配置 / 用户数据。
 *  - 行对齐只走 LCS（base→local、base→remote），同一行内容重复时也不会错位；单侧变更区间
 *    超过 DP 上限时退化为「整段替换」——宁可粗粒度报冲突，也不做定位猜测。
 *  - 文本比较按「去行尾」后的内容进行：CRLF/LF 混用不得误报冲突；输出保留输入的行尾风格。
 *  - 缺共同祖先（ancestor === undefined）→ ok:false：由上层按整文件冲突处理，本模块不猜。
 */

/** 文本判定与文本合并的缺省字节上限：1 MiB。超限一律按「太大不合并」处理。 */
export const TEXT_MERGE_MAX_BYTES = 1024 * 1024;

/** 单条冲突。local/remote/ancestor 是原始值：JSON 合并给原始 JSON 值，文本合并给字符串片段。 */
export interface TextMergeConflict {
  /** 冲突位置：JSON 合并是点号路径（'a.b.c'，根为 ''）；文本合并是 'line 12-14'（或单点 'line 7'）。 */
  path: string;
  reason: 'overlap' | 'array' | 'format' | 'binary' | 'too-large';
  local?: unknown;
  remote?: unknown;
  ancestor?: unknown;
}

/** JSON 值级合并结果；ok 为 false 时 merged 缺省（绝不把半成品当结果）。 */
export interface JsonMergeResult {
  ok: boolean;
  merged?: unknown;
  conflicts: TextMergeConflict[];
}

/** 合并内容形态：合法 JSON 文本 / 行级文本 / 二进制 / 超限。 */
export type TextMergeKind = 'text' | 'json' | 'binary' | 'too-large';

/** 文本（或字节）三方合并结果。 */
export interface TextMergeResult {
  ok: boolean;
  merged?: string;
  conflicts: TextMergeConflict[];
  kind: TextMergeKind;
}

/** 字节三方合并结果。 */
export interface TextBytesMergeResult {
  ok: boolean;
  merged?: Uint8Array;
  conflicts: TextMergeConflict[];
  kind: TextMergeKind;
}

// ---------------------------------------------------------------------------
// 形态判定
// ---------------------------------------------------------------------------

/**
 * 是否像文本：含 NUL 字节 / 非法 UTF-8 / 超过 maxBytes（缺省 1 MiB）→ false。
 * 只做形态判定，不做解码；调用方拿到 true 后可用 UTF-8 解码。
 */
export function looksLikeText(bytes: Uint8Array, maxBytes: number = TEXT_MERGE_MAX_BYTES): boolean {
  if (bytes.length > maxBytes) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 严格 JSON 解析（不做 JSON5 / 注释 / 尾逗号宽容）：解析失败返回 ok:false。 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 字节形态判定（超限优先于二进制：两者都不可合并，但超限更能解释「为什么没合并」）。 */
function classifyBytes(bytes: Uint8Array): TextMergeKind {
  if (bytes.length > TEXT_MERGE_MAX_BYTES) return 'too-large';
  if (!looksLikeText(bytes)) return 'binary';
  return 'text';
}

/** 取最「坏」的形态：too-large > binary > text。 */
function worstKind(kinds: TextMergeKind[]): TextMergeKind {
  if (kinds.includes('too-large')) return 'too-large';
  if (kinds.includes('binary')) return 'binary';
  return 'text';
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ---------------------------------------------------------------------------
// JSON 结构化三方合并
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 结构相等（对象按 key 集合比较，与键顺序无关）——三方合并的「未改动」判据。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!hasOwn(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/** 点号路径拼接：根为 ''，子键为 'a' / 'a.b'。 */
function childPath(parent: string, key: string): string {
  return parent === '' ? key : parent + '.' + key;
}

/**
 * 三方合并 JSON 值（递归，任意深度）。
 *  - 双侧相同 → 该值（收敛）；
 *  - 仅一侧相对祖先改动 → 采纳该侧；
 *  - 对象（祖先缺省或同为对象）→ 按键递归，**缺失键 = 删除语义**：
 *      一侧删除 + 另一侧未改 → 删除胜出；一侧删除 + 另一侧改了 → 冲突；
 *      单侧新增（祖先没有）→ 采纳；双侧都新增且不同 → 冲突；
 *  - 数组绝不按索引合并：双侧都改且不 deepEqual → 冲突（reason='array'）；
 *  - 其余（标量双向改动、类型互换）→ 冲突（reason='overlap'）。
 */
export function mergeJsonValues(ancestor: unknown, local: unknown, remote: unknown, path = ''): JsonMergeResult {
  const conflicts: TextMergeConflict[] = [];
  const merged = resolveJsonValue(ancestor, local, remote, path, conflicts);
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, merged, conflicts: [] };
}

function resolveJsonValue(
  ancestor: unknown,
  local: unknown,
  remote: unknown,
  path: string,
  conflicts: TextMergeConflict[],
): unknown {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(local, ancestor)) return remote;
  if (deepEqual(remote, ancestor)) return local;
  // 双侧都改且不等：只有「两侧都是对象且祖先缺省或同为对象」才允许继续递归。
  if (isPlainObject(local) && isPlainObject(remote) && (ancestor === undefined || isPlainObject(ancestor))) {
    return mergeJsonObjects(isPlainObject(ancestor) ? ancestor : undefined, local, remote, path, conflicts);
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    // 数组语义不明：绝不按索引乱合，交给用户裁决。
    conflicts.push({ path, reason: 'array', local, remote, ancestor });
    return undefined;
  }
  conflicts.push({ path, reason: 'overlap', local, remote, ancestor });
  return undefined;
}

function mergeJsonObjects(
  ancestor: Record<string, unknown> | undefined,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  path: string,
  conflicts: TextMergeConflict[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set<string>([...Object.keys(ancestor ?? {}), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const here = childPath(path, key);
    const hasLocal = hasOwn(local, key);
    const hasRemote = hasOwn(remote, key);
    const hasAncestor = ancestor !== undefined && hasOwn(ancestor, key);
    const ancestorValue = hasAncestor ? ancestor![key] : undefined;
    if (hasLocal && hasRemote) {
      out[key] = resolveJsonValue(ancestorValue, local[key], remote[key], here, conflicts);
      continue;
    }
    if (!hasLocal && !hasRemote) continue; // 双侧都删：此处无键，无需报告
    const localSide = hasLocal;
    const value = localSide ? local[key] : remote[key];
    if (!hasAncestor) {
      // 单侧新增：直接采纳（双侧都新增会走上面的分支）。
      out[key] = value;
      continue;
    }
    if (deepEqual(value, ancestorValue)) continue; // 另一侧删除、这一侧没改 → 删除胜出
    conflicts.push({
      path: here,
      reason: 'overlap',
      local: localSide ? local[key] : undefined,
      remote: localSide ? undefined : remote[key],
      ancestor: ancestorValue,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 行级文本三方合并
// ---------------------------------------------------------------------------

/** 一行：内容（不含行尾）+ 行尾（'\n' | '\r\n' | ''）。 */
interface LineEntry {
  text: string;
  eol: string;
}

/** 拆行：只把 '\n' 当行尾（CRLF 记为 '\r\n' 行尾）；末尾没有换行时最后一行 eol 为空串。 */
function splitLines(text: string): LineEntry[] {
  if (text === '') return [];
  const out: LineEntry[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue; // '\n'
    const hasCr = i > start && text.charCodeAt(i - 1) === 13; // '\r'
    out.push({ text: text.slice(start, hasCr ? i - 1 : i), eol: hasCr ? '\r\n' : '\n' });
    start = i + 1;
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: '' });
  return out;
}

/**
 * 输出行尾风格：三种输入里只有 CRLF → CRLF，只有 LF → LF；
 * 混用时优先跟随占多数的祖先，其次本地，最后回落 LF。
 * （仅用于补齐「本来没有行尾、但合并后不在末行」的行——绝不改写原有行尾。）
 */
function detectEol(ancestorText: string, localText: string, remoteText: string): string {
  const count = (t: string): { crlf: number; lf: number } => {
    let crlf = 0;
    let lf = 0;
    for (let i = 0; i < t.length; i++) {
      if (t.charCodeAt(i) !== 10) continue;
      if (i > 0 && t.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
    return { crlf, lf };
  };
  const a = count(ancestorText);
  const l = count(localText);
  const r = count(remoteText);
  const crlf = a.crlf + l.crlf + r.crlf;
  const lf = a.lf + l.lf + r.lf;
  if (crlf > 0 && lf === 0) return '\r\n';
  if (lf > 0 && crlf === 0) return '\n';
  if (crlf === 0) return '\n';
  if (a.crlf !== a.lf) return a.crlf > a.lf ? '\r\n' : '\n';
  if (l.crlf !== l.lf) return l.crlf > l.lf ? '\r\n' : '\n';
  return '\n';
}

/** 合并后重建文本：非末行的空行尾用 preferredEol 补齐（否则会把两行粘成一行）。 */
function rebuildLines(entries: LineEntry[], preferredEol: string): string {
  let out = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    out += e.text;
    if (i < entries.length - 1) out += e.eol === '' ? preferredEol : e.eol;
    else out += e.eol;
  }
  return out;
}

/** 单侧变更：base 上 [baseStart, baseEnd) 被 lines 替换（lines 为空 = 纯删除）。 */
interface ChangeHunk {
  baseStart: number;
  baseEnd: number;
  lines: LineEntry[];
}

/** 0 = 相同，-1 = 删除，1 = 插入。 */
type DiffOp = 0 | -1 | 1;

/** 变更区间过大时的 DP 上限（n*m）；超过则整段替换，绝不做定位猜测。 */
const DIFF_DP_LIMIT = 4_000_000;

/** 行级 diff（裁剪公共前后缀 + LCS 回溯）；只比较内容，不含行尾。 */
function diffOps(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (start < maxPrefix && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push(0);
  if (n === 0) {
    for (let j = 0; j < m; j++) ops.push(1);
  } else if (m === 0) {
    for (let i = 0; i < n; i++) ops.push(-1);
  } else if (n * m <= DIFF_DP_LIMIT) {
    const width = m + 1;
    const lcs = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const diag = lcs[(i + 1) * width + j + 1]!;
        const down = lcs[(i + 1) * width + j]!;
        const right = lcs[i * width + j + 1]!;
        lcs[i * width + j] = midA[i] === midB[j] ? diag + 1 : Math.max(down, right);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push(0);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        ops.push(-1);
        i++;
      } else {
        ops.push(1);
        j++;
      }
    }
    while (i < n) {
      ops.push(-1);
      i++;
    }
    while (j < m) {
      ops.push(1);
      j++;
    }
  } else {
    for (let i = 0; i < n; i++) ops.push(-1);
    for (let j = 0; j < m; j++) ops.push(1);
  }
  for (let k = 0; k < a.length - endA; k++) ops.push(0);
  return ops;
}

/** 把单侧 diff 归并成变更区间（连续删除/插入合成一个 hunk）。 */
function changeHunks(base: LineEntry[], side: LineEntry[]): ChangeHunk[] {
  const ops = diffOps(
    base.map((e) => e.text),
    side.map((e) => e.text),
  );
  const hunks: ChangeHunk[] = [];
  let baseIdx = 0;
  let sideIdx = 0;
  let open: { baseStart: number; lines: LineEntry[] } | null = null;
  const close = (): void => {
    if (open === null) return;
    hunks.push({ baseStart: open.baseStart, baseEnd: baseIdx, lines: open.lines });
    open = null;
  };
  for (const op of ops) {
    if (op === 0) {
      close();
      baseIdx++;
      sideIdx++;
      continue;
    }
    if (open === null) open = { baseStart: baseIdx, lines: [] };
    if (op === -1) baseIdx++;
    else {
      const entry = side[sideIdx];
      if (entry) open.lines.push(entry);
      sideIdx++;
    }
  }
  close();
  return hunks;
}

/** 冲突位置措辞（1-based，base 上的区间）：单行/纯插入点 'line 7'，多行 'line 12-14'。 */
function lineRange(start: number, end: number): string {
  if (end <= start + 1) return 'line ' + (start + 1);
  return 'line ' + (start + 1) + '-' + end;
}

function joinTexts(entries: LineEntry[]): string {
  return entries.map((e) => e.text).join('\n');
}

/**
 * 行级三方合并：base→local、base→remote 各自算变更区间，不重叠的全部应用；
 * 重叠区间两侧结果逐字相同 → 收敛为一份，否则冲突（path='line X-Y'）。
 */
export function mergeTextThreeWay(ancestor: string, local: string, remote: string): TextMergeResult {
  const ancestorJson = tryParseJson(ancestor);
  const localJson = tryParseJson(local);
  const remoteJson = tryParseJson(remote);
  if (ancestorJson.ok && localJson.ok && remoteJson.ok) {
    const json = mergeJsonValues(ancestorJson.value, localJson.value, remoteJson.value);
    if (json.ok) {
      return { ok: true, merged: JSON.stringify(json.merged, null, 2) + '\n', conflicts: [], kind: 'json' };
    }
    return { ok: false, conflicts: json.conflicts, kind: 'json' };
  }
  return mergeTextLines(ancestor, local, remote);
}

function mergeTextLines(ancestor: string, local: string, remote: string): TextMergeResult {
  const base = splitLines(ancestor);
  const localHunks = changeHunks(base, splitLines(local));
  const remoteHunks = changeHunks(base, splitLines(remote));
  const preferredEol = detectEol(ancestor, local, remote);
  const conflicts: TextMergeConflict[] = [];
  const out: LineEntry[] = [];
  let cursor = 0;
  let i = 0;
  let j = 0;
  const emitSingle = (hunk: ChangeHunk): void => {
    for (let k = cursor; k < hunk.baseStart; k++) {
      const line = base[k];
      if (line) out.push(line);
    }
    for (const line of hunk.lines) out.push(line);
    cursor = hunk.baseEnd;
  };
  while (i < localHunks.length || j < remoteHunks.length) {
    const a = localHunks[i];
    const b = remoteHunks[j];
    if (b === undefined) {
      emitSingle(a!);
      i++;
      continue;
    }
    if (a === undefined) {
      emitSingle(b);
      j++;
      continue;
    }
    // 同一位置的纯插入（双侧都往这一点塞内容）必须按重叠处理：否则会把两份内容直接拼起来。
    const bothEmptyAtSamePoint =
      a.baseStart === a.baseEnd && b.baseStart === b.baseEnd && a.baseStart === b.baseStart;
    if (!bothEmptyAtSamePoint) {
      if (a.baseEnd <= b.baseStart) {
        emitSingle(a);
        i++;
        continue;
      }
      if (b.baseEnd <= a.baseStart) {
        emitSingle(b);
        j++;
        continue;
      }
    }
    // 重叠：交替扩张并集，直到两侧都没有 hunk 再与之相交
    let start = Math.min(a.baseStart, b.baseStart);
    let end = Math.max(a.baseEnd, b.baseEnd);
    let ai = i;
    let bj = j;
    for (;;) {
      let grew = false;
      while (ai + 1 < localHunks.length && localHunks[ai + 1]!.baseStart < end) {
        ai++;
        end = Math.max(end, localHunks[ai]!.baseEnd);
        grew = true;
      }
      while (bj + 1 < remoteHunks.length && remoteHunks[bj + 1]!.baseStart < end) {
        bj++;
        end = Math.max(end, remoteHunks[bj]!.baseEnd);
        grew = true;
      }
      if (!grew) break;
    }
    const localLines: LineEntry[] = [];
    for (let k = i; k <= ai; k++) localLines.push(...localHunks[k]!.lines);
    const remoteLines: LineEntry[] = [];
    for (let k = j; k <= bj; k++) remoteLines.push(...remoteHunks[k]!.lines);
    for (let k = cursor; k < start; k++) {
      const line = base[k];
      if (line) out.push(line);
    }
    if (joinTexts(localLines) === joinTexts(remoteLines)) {
      // 两侧改成逐字相同的结果 → 收敛为一份（不报冲突）
      for (const line of localLines) out.push(line);
    } else {
      conflicts.push({
        path: lineRange(start, end),
        reason: 'overlap',
        local: joinTexts(localLines),
        remote: joinTexts(remoteLines),
        ancestor: joinTexts(base.slice(start, end)),
      });
    }
    cursor = end;
    i = ai + 1;
    j = bj + 1;
  }
  for (let k = cursor; k < base.length; k++) {
    const line = base[k];
    if (line) out.push(line);
  }
  if (conflicts.length > 0) return { ok: false, conflicts, kind: 'text' };
  return { ok: true, merged: rebuildLines(out, preferredEol), conflicts: [], kind: 'text' };
}

// ---------------------------------------------------------------------------
// 字节级入口
// ---------------------------------------------------------------------------

/**
 * 字节三方合并：
 *  - ancestor === undefined → ok:false（无共同祖先，由上层按整文件冲突处理，绝不猜）；
 *  - 任一侧二进制 / 超限（含 ancestor）→ ok:false，kind 如实（'binary' / 'too-large'）；
 *  - 否则解码为文本走 mergeTextThreeWay，成功后按 UTF-8 编码回字节。
 */
export function mergeBytesThreeWay(
  ancestor: Uint8Array | undefined,
  local: Uint8Array,
  remote: Uint8Array,
): TextBytesMergeResult {
  if (ancestor === undefined) {
    return { ok: false, conflicts: [], kind: worstKind([classifyBytes(local), classifyBytes(remote)]) };
  }
  const kind = worstKind([classifyBytes(ancestor), classifyBytes(local), classifyBytes(remote)]);
  if (kind === 'binary' || kind === 'too-large') {
    return { ok: false, conflicts: [{ path: '', reason: kind }], kind };
  }
  const result = mergeTextThreeWay(decodeUtf8(ancestor), decodeUtf8(local), decodeUtf8(remote));
  if (!result.ok || result.merged === undefined) {
    return { ok: false, conflicts: result.conflicts, kind: result.kind };
  }
  return { ok: true, merged: new TextEncoder().encode(result.merged), conflicts: [], kind: result.kind };
}
