/**
 * patch 行写回守卫（issue #136 A + C）。
 *
 * 背景：导出侧 SecretScanner 会把命中字段名/值形状的字符串叶子替换成空串（占位符），语义是
 * 「需补录」。同步/导入落盘时，若照抄这个空串，就会**静默**抹掉本机同一行里用户手写的明文
 * —— 行是整行写回的，行内没有粒度。
 *
 * 本模块是那条「最后一个能拒绝写入」的纯逻辑：比对导入值与本机当前行，把「被脱敏剥空」的
 * 叶子换回本机值；只有调用方显式声明逐行确认（`confirmed`）才允许真的写空。
 *
 * 两条分支（issue #136 C 的载荷字段决定）：
 *  - `redactedPaths` 存在（新载荷）：只保护**声明过的**路径，精确、可解释；
 *  - 缺省（旧载荷 / 未知）：保守口径 —— 导入值为空串且本机同叶子非空即保留本机值。
 *    绝不反过来假定「空值一定来自用户主动清空」（旧载荷没有能力区分剥空与真空）。
 *
 * 纯函数：不读盘、不打日志、不抛错；返回值不含任何值本身（只有路径），可直接进报告。
 */

/** 路径段（对象键或数组下标）。 */
type Segment = string | number;

export interface PatchSecretGuardInput {
  /** 备份/远端载荷里的整行值（可能含被剥空的叶子）。 */
  importedRaw: unknown;
  /** 本机当前同一行的值；`undefined` = 本机没有这一行（Create 语义，无可保护对象）。 */
  localRaw: unknown;
  /** 载荷声明的剥空路径（行内相对，如 `raw.mcp.args.token`）；缺省 = 未知（旧载荷）。 */
  redactedPaths?: readonly string[] | undefined;
  /** 调用方已拿到对该行的**逐行显式确认** → 允许写空。 */
  confirmed: boolean;
}

export interface PatchSecretGuardResult {
  /** 实际应写入的行值（受保护叶子已换回本机值）。 */
  raw: unknown;
  /** 被保留的本机值路径（行内相对，展示用）。 */
  kept: string[];
  /** 逐行确认后真的写空的路径（同一份事实进报告）。 */
  cleared: string[];
  /** true = 载荷没带剥空路径，走的是保守推断分支。 */
  conservative: boolean;
}

/** 解析扫描器路径语法（`a.b[0].c`）→ 路径段；语法不认识返回 null（宁可放过，不误判）。 */
function parsePath(path: string): Segment[] | null {
  const segs: Segment[] = [];
  let rest = path;
  while (rest !== '') {
    const m = /^([^.[\]]+)((?:\[\d+\])*)/.exec(rest);
    if (m === null) return null;
    const head = m[1];
    const tail = m[2] ?? '';
    if (head === undefined) return null;
    segs.push(head);
    for (const hit of tail.matchAll(/\[(\d+)\]/g)) {
      const idx = hit[1];
      if (idx !== undefined) segs.push(Number(idx));
    }
    rest = rest.slice(m[0].length);
    if (rest === '') break;
    if (!rest.startsWith('.')) return null;
    rest = rest.slice(1);
  }
  return segs.length > 0 ? segs : null;
}

/** 路径段 → 展示用相对路径（与扫描器语法同形，如 `raw.mcp.args.token`）。 */
function formatPath(segs: readonly Segment[]): string {
  let out = '';
  for (const seg of segs) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? seg : `.${seg}`;
  }
  return out;
}

function getAt(root: unknown, segs: readonly Segment[]): unknown {
  let cur = root;
  for (const seg of segs) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** 深拷贝后按路径写回（只在确有保护项时调用，避免无谓的整行拷贝）。 */
function setAt(root: unknown, segs: readonly Segment[], value: unknown): unknown {
  if (segs.length === 0) return value;
  const clone = structuredClone(root);
  let cur: Record<string, unknown> | unknown[] = clone as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = Array.isArray(cur)
      ? (cur as unknown[])[segs[i] as number]
      : (cur as Record<string, unknown>)[segs[i] as string];
    if (next === null || typeof next !== 'object') return clone; // 形状不符 → 不猜，原样返回
    cur = next as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur)) (cur as unknown[])[last as number] = value;
  else (cur as Record<string, unknown>)[last as string] = value;
  return clone;
}

/** 本机值是否「非空」：只有非空字符串算（脱敏占位符恒为空串，故此判据与载荷同口径）。 */
function isNonEmptyLocal(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 保守分支：逐叶子找出「导入空串 + 本机非空」的路径（旧载荷没有剥空信息时的唯一线索）。 */
function collectSuspects(imported: unknown, local: unknown, segs: Segment[], out: Segment[][]): void {
  if (imported === null || typeof imported !== 'object') {
    if (imported === '' && isNonEmptyLocal(local)) out.push([...segs]);
    return;
  }
  if (Array.isArray(imported)) {
    for (let i = 0; i < imported.length; i++) {
      collectSuspects(imported[i], Array.isArray(local) ? local[i] : undefined, [...segs, i], out);
    }
    return;
  }
  const obj = imported as Record<string, unknown>;
  const localObj = local !== null && typeof local === 'object' && !Array.isArray(local)
    ? (local as Record<string, unknown>)
    : undefined;
  for (const [k, v] of Object.entries(obj)) collectSuspects(v, localObj?.[k], [...segs, k], out);
}

export function applyPatchSecretGuard(input: PatchSecretGuardInput): PatchSecretGuardResult {
  const { importedRaw, localRaw, redactedPaths, confirmed } = input;
  // 本机没有这一行 → 没有可覆盖的东西（Create 语义），原样返回。
  if (localRaw === undefined) return { raw: importedRaw, kept: [], cleared: [], conservative: false };

  const conservative = redactedPaths === undefined || redactedPaths.length === 0;
  /** 候选：相对路径段（不含 `raw` 前缀；空数组 = 整行值本身）。 */
  const candidates: { segs: Segment[]; declared: boolean }[] = [];
  if (conservative) {
    const found: Segment[][] = [];
    collectSuspects(importedRaw, localRaw, [], found);
    for (const segs of found) candidates.push({ segs, declared: false });
  } else {
    for (const path of redactedPaths) {
      const segs = parsePath(path);
      if (segs === null) continue;
      // 载荷里的路径是相对**行对象**（`{ file, lineId, raw }`）的；行内相对只剩 `raw` 之后的部分。
      const rel = segs[0] === 'raw' ? segs.slice(1) : segs;
      candidates.push({ segs: rel, declared: true });
    }
  }

  const kept: string[] = [];
  const cleared: string[] = [];
  let raw = importedRaw;
  for (const cand of candidates) {
    const localVal = getAt(localRaw, cand.segs);
    if (!isNonEmptyLocal(localVal)) continue;
    const importedVal = getAt(importedRaw, cand.segs);
    // 声明路径上出现了非空导入值 = 载荷自相矛盾（或值形状命中后被上游改回）：以导入值为准，
    // 绝不因为声明了路径就把远端真实新值挡掉（issue #136 验收 3）。
    if (importedVal === '' || importedVal === undefined) {
      const rel = formatPath(['raw', ...cand.segs]);
      if (confirmed) cleared.push(rel);
      else {
        kept.push(rel);
        raw = setAt(raw, cand.segs, localVal);
      }
    }
  }
  return { raw, kept, cleared, conservative };
}

export const __test = { parsePath, formatPath };
