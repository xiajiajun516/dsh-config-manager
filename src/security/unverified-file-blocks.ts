/**
 * SEC-05（表外条目）的**唯一**判定点：把「未登记进校验表、却会被落盘」的文件分区计划项
 * 拦在执行之前。
 *
 * 为什么单独成模块：
 *  - 判据落在一处才审得动 —— 文件前缀组合、会写盘的 kind、目录/结构文件排除，任何一处改口径都
 *    同时影响「告警」与「阻断」，两边分叉就等于自己骗自己；
 *  - `src/core/analyzer.ts` 有体量棘轮（tests/file-size-ratchet.test.ts），这类判定应下沉到
 *    `src/security/`，而不是让分析器继续变胖。
 *
 * 本模块**不**反向依赖 `src/core/*` 的值：只声明用到的字段结构（`PlanItem` 结构可赋值），
 * 消息翻译走注入的 `MsgFunc`，因此不与 core 形成环。
 */
import { SECTION_FILE_PREFIXES } from '../schema/config.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import { parseJsonSafe } from '../utils/json.ts';
import { verifyChecksums } from '../utils/hashing.ts';
import type { ChecksumVerifyResult } from '../utils/hashing.ts';
import { UNVERIFIED_FILE_ENTRY_CODE, UNVERIFIED_FILE_ENTRY_KEY, unverifiedEntries } from './integrity.ts';
import type { SectionId } from '../schema/types.ts';
import type { MsgFunc } from '../core/msg-types.ts';

/**
 * 本模块需要的计划项字段（结构子集）。刻意不 import `core/types.ts` 的 `PlanItem`：
 * 值依赖方向是 core → security，security 只描述契约。
 */
export interface UnverifiedBlockableItem {
  adapter: string;
  kind: string;
  severity?: string;
  detail?: string;
  description?: string;
  target?: { ref?: string } | undefined;
}

/**
 * SEC-05 文案：优先用专属键 `import.unverifiedFileEntry`。
 *
 * 字典还没收录该键时 `msg` 会回退成键名本身（messages.ts 的「未知键绝不抛错」约定），
 * 那样文案里只有键名、**连是哪个文件都没说** —— 对用户是最糟的形态。因此回退到既有的
 * `import.extraEntries`（已翻译、也带条目名）。两段指向同一事实：「这个条目没被校验表覆盖」。
 */
/** 单条文案最多列几个条目 —— 校验表缺失时名单 = 整包文件分区条目，不截断会撑爆一条 warning。 */
const MAX_LISTED_ENTRIES = 10;

export function unverifiedFileEntryText(text: MsgFunc, names: readonly string[]): string {
  return render(text, UNVERIFIED_FILE_ENTRY_KEY, names);
}

function render(text: MsgFunc, key: string, names: readonly string[]): string {
  const head = names.slice(0, MAX_LISTED_ENTRIES).map((n) => `"${n}"`).join(', ');
  const list = names.length > MAX_LISTED_ENTRIES ? `${head} …(+${names.length - MAX_LISTED_ENTRIES})` : head;
  const rendered = text(key, { entries: list });
  return rendered === key ? text('import.extraEntries', { entries: list }) : rendered;
}

/**
 * 未覆盖条目的**唯一**一条告警（RV1-F11：同一事实只发一次，不再与 `import.extraEntries` 并存）。
 *
 * 键按「到底拦没拦」选，避免文案自称做了没做的事：
 *  - 真拦下了（blocked > 0）⇒ 专属键 `import.unverifiedFileEntry`（「已逐条阻断写入」）；
 *  - 一个都没拦（豁免分区 / 不在任何文件分区前缀下的散落条目，守 INT-01）⇒ 中性口径 `import.extraEntries`。
 */
export function unverifiedNoticeText(text: MsgFunc, names: readonly string[], blocked: number): string {
  return render(text, blocked > 0 ? UNVERIFIED_FILE_ENTRY_KEY : 'import.extraEntries', names);
}

/** 归档里的结构文件（不属于内容，永不参与「未覆盖」判定）。 */
const STRUCTURAL_FILES = [MANIFEST_FILE, CHECKSUMS_FILE];

/** 落在文件分区前缀下的归档条目（目录标记条目与结构文件排除）。 */
function fileSectionEntries(names: readonly string[]): string[] {
  const skip = new Set(STRUCTURAL_FILES);
  const prefixes = Object.values(SECTION_FILE_PREFIXES).filter((prefix) => prefix !== '');
  return names.filter((n) => !n.endsWith('/') && !skip.has(n) && prefixes.some((p) => n.startsWith(p)));
}

/**
 * 校验表**覆盖不到**的条目（反向覆盖）。
 *
 * - 表存在且非空：表里没登记的条目（`unverifiedEntries` 的判据，正向校验看不到它们）；
 * - 表**缺失/为空**：一个条目都没被校验 ⇒ 文件分区前缀下的条目一律视为未覆盖。
 *   这是 RV1-F1 抓到的绕过：删掉 `integrity/checksums.json`（或置 `{}`）就等于把 SEC-05 关掉。
 *   口径选「逐条 fail-closed」而非整包拒：旧包/手工包的非文件分区（settings 等）照常导入，
 *   被拦下的只是「按归档名原样落盘、完整性声明又完全管不到」的那部分。
 *
 * 文案不在这里出（RV1-F11）：同一事实只由 `analyzeImport` 发一条 `import.unverifiedFileEntry`。
 */
export function scanUnverifiedEntries(names: readonly string[], table: Record<string, string> | null): string[] {
  if (table === null || Object.keys(table).length === 0) return fileSectionEntries(names);
  return unverifiedEntries(names, table, STRUCTURAL_FILES);
}

/** 会写盘的计划项 kind（Skip 本来就不写目标，改成 Error 只会让无害 no-op 显示成失败）。 */
const WRITING_KINDS = new Set(['Create', 'Update', 'Conflict']);

/**
 * 把命中「表外 + 会写盘」的文件分区计划项升级为 Error。
 *
 * 为什么必须拦：文件集合分区按归档名原样落盘（`adapters/file-collection.ts` 的 applyItem 只看
 * `target.ref`），而 `verifyAgainstTable` 只正向校验表里登记的条目 —— 表外文件一路绿灯。
 * 拦在执行之前、拦在计划项上（kind:'Error'）：`applyOne` 遇到 Error 直接记 failed、绝不写目标，
 * 用户也能在预览里看到「为什么这条没导」。
 *
 * @returns 被阻断的归档条目名（按计划项顺序，供调用方汇总一条提示）
 */
export function applyUnverifiedFileBlocks(
  unverified: readonly string[],
  items: UnverifiedBlockableItem[],
  fileSections: ReadonlySet<string>,
  exemptSections: readonly string[],
  text: MsgFunc,
): string[] {
  if (unverified.length === 0) return [];
  const unverifiedSet = new Set(unverified);
  const exempt = new Set<string>(exemptSections);
  const blocked: string[] = [];
  for (const item of items) {
    if (!fileSections.has(item.adapter) || exempt.has(item.adapter)) continue;
    if (!WRITING_KINDS.has(item.kind)) continue;
    const ref = item.target?.ref;
    if (ref === undefined) continue;
    const archiveName = (SECTION_FILE_PREFIXES[item.adapter as SectionId] ?? '') + ref;
    if (!unverifiedSet.has(archiveName)) continue;
    item.kind = 'Error';
    item.severity = 'error';
    item.detail = UNVERIFIED_FILE_ENTRY_CODE;
    item.description = unverifiedFileEntryText(text, [archiveName]);
    blocked.push(archiveName);
  }
  return blocked;
}

/** ZIP 归档读取子集（结构子集：`ZipArchive` 可赋值）；本模块不 import core 的 ZIP 解析。 */
export interface IntegrityArchive {
  has(name: string): boolean;
  names(): string[];
  readEntryText(name: string): string;
  readEntryAsync(name: string): Promise<Uint8Array>;
}

export interface ArchiveIntegrityScan {
  checksums: ChecksumVerifyResult;
  /** 表外条目（反向覆盖）；校验表缺失/为空时 = 文件分区前缀下的全部条目（见 scanUnverifiedEntries） */
  unverified: string[];
  /** 要挂进 zipWarnings 的文案（目前只有「校验表缺失」；反向覆盖文案由 analyzeImport 统一发一条） */
  warnings: string[];
  /** 完整性不符时的错误文案；undefined = 通过（调用方自己 throw，文案由注入的 msg 决定） */
  failure?: string;
}

/**
 * 归档完整性扫描：正向（表内每条必须存在且 SHA-256 一致）+ 反向（ZIP 有、表里没登记）。
 *
 * 正向用 `utils/hashing.ts` 的 `verifyChecksums` —— 与 `import-planning.ts` 里的同名判据逐字等价，
 * 是同一份语义的规范实现，此处不再复制第二遍。
 * 判定却必须与导入阻断共用（`scanUnverifiedEntries` / `unverifiedEntries`），否则「告警说的表外条目」
 * 与「真正被拦下的条目」会分叉。
 */
export async function scanArchiveIntegrity(archive: IntegrityArchive, text: MsgFunc): Promise<ArchiveIntegrityScan> {
  const warnings: string[] = [];
  const names = archive.names();
  // 校验表缺失或为空：全部条目都处于「未登记 ⇒ 未被校验」，两种形态对用户是同一件事，共用一条告警。
  // 此时 checksums 恒 ok（没有可正向校验的声明），防线全靠下一行 scanUnverifiedEntries 的 fail-closed。
  const table = archive.has(CHECKSUMS_FILE)
    ? (parseJsonSafe(archive.readEntryText(CHECKSUMS_FILE)) as Record<string, string>)
    : null;
  if (table === null || Object.keys(table).length === 0) warnings.push(text('import.checksumsMissing'));
  let checksums: ChecksumVerifyResult = { ok: true, mismatches: [], missing: [] };
  if (table !== null && Object.keys(table).length > 0) {
    const entries = new Map<string, Uint8Array>();
    // 异步解压：这是全仓唯一逐条解压全部条目的地方（`inflateRawSync` 会整段阻塞事件循环）。
    for (const name of names) {
      if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
      try {
        entries.set(name, await archive.readEntryAsync(name));
      } catch {
        entries.delete(name); // 损坏条目在完整性阶段即失败（最终体现为 missing）
      }
    }
    checksums = verifyChecksums(entries, table);
  }
  // 反向覆盖只出条目名，文案统一由 analyzeImport 发一条（RV1-F11：同一事实不重复告警）。
  const unverified = scanUnverifiedEntries(names, table);
  const failure = checksums.ok
    ? undefined
    : text('import.integrityFailed', {
      entries: [...checksums.mismatches, ...checksums.missing].map((m) => `"${m}"`).join(', '),
    });
  return { checksums, unverified, warnings, ...(failure !== undefined ? { failure } : {}) };
}

