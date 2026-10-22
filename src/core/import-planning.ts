/**
 * 导入「计划期纯函数」集合（P4 拆分）：从 `core/analyzer.ts` 尾部原样外提，**零行为改动**。
 *
 * 为什么单独成文件：analyzer 曾 1824 行、装着三段式引擎 + 13 个互不相关的纯函数，
 * 任何一处（如墓碑过滤）的阅读都得先跳过引擎实现。这里只收「不碰 fs、不改入参」的纯计算，
 * 引擎类（Analyzer）留在 `analyzer.ts`；两者单向依赖：analyzer → 本模块，本模块不 import analyzer。
 *
 * 对外导入面不变：analyzer.ts 仍 re-export 原本导出的 3 个名字（rebaseMapping /
 * applyMappingsToSections / runSchemaMigration），core/index.ts 与既有测试无需改 import。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { isAbsolutePath, applyPrefixMappings } from '../utils/paths.ts';
import { isFileSection } from '../schema/config.ts';
import { validateManifest } from '../schema/manifest.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import { migrateToCurrent } from '../migrations/index.ts';
import { isTombstoned } from '../schema/tombstones.ts';
import type { Tombstone, TombstoneKind } from '../schema/tombstones.ts';
import type { MsgFunc } from './messages.ts';
import type {
  PathIssue, PathMapping, PlanItem, SkippedTombstone, TransactionSnapshotContext,
} from './types.ts';

/* ---------------- journal 结果上报（引擎 → 宿主） ---------------- */

/**
 * 引擎向 journal 宿主上报「已就地回滚」的最小面。
 *
 * 刻意在本文件内声明结构等价的最小类型，而不给 `core/types.ts` 的 TransactionSnapshotContext
 * 增字段：该契约文件属并行会话的改动范围（t16 的 out of scope），且这只是**可选**上报 ——
 * 非 journaled 调用方（CLI/测试）不传 snapshotBinding，行为逐字节不变。
 * 实现侧见 `core/phase3-host.ts` 的 JournalRunContext.recordRollback（绝不抛错）。
 */
type RollbackReportingBinding = TransactionSnapshotContext & {
  recordRollback?: (report: { full: boolean; failed: readonly string[] }) => Promise<void>;
};

export async function reportRollbackToJournal(
  binding: TransactionSnapshotContext | undefined,
  report: { full: boolean; failed: readonly string[] },
): Promise<void> {
  const reporter = binding as RollbackReportingBinding | undefined;
  await reporter?.recordRollback?.(report);
}

/* ---------------- 纯函数辅助 ---------------- */

/**
 * G-06：执行 schema 迁移链并把迁移结果重新校验为合法 manifest。
 *
 * `migrateToCurrent` 此前在 `src/` 内零引用（迁移链有定义、有单测、从不执行）；
 * `loadBundle` 只用 isSupported 做判定就直接把旧文档当新格式使用。本函数是迁移链的
 * **真实接线点**：沿链迁移 → 重新校验结果是合法 manifest（不合法则抛明确错误，
 * 绝不把半迁移文档当合法 manifest 继续）→ 每个已应用步骤翻译成用户可见告警。
 *
 * 显式传入 from/target 使「链式迁移真的被执行」可被直接单测：当前
 * `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，`needsMigration` 恒假，
 * 因此该分支在真实导入中结构上不可达（loadBundle 仍按 needsMigration 调用本函数）。
 */
export function runSchemaMigration(
  doc: unknown,
  fromVersion: number,
  targetVersion: number,
  msg: MsgFunc,
): { manifest: Manifest; warnings: string[] } {
  const result = migrateToCurrent(doc, fromVersion, targetVersion);
  const issues = validateManifest(result.doc).filter((i) => i.severity === 'error');
  if (issues.length > 0) {
    throw new Error(msg('import.migrateInvalidManifest', { issues: issues.map((i) => i.message).join('; ') }));
  }
  return {
    manifest: result.doc as Manifest,
    warnings: result.applied.map((step) => msg('import.migrated', { from: String(step.from), to: String(step.to) })),
  };
}

export async function verifyAgainstTable(
  entries: Map<string, Uint8Array>,
  table: Record<string, string>,
): Promise<{ ok: boolean; mismatches: string[]; missing: string[] }> {
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [relPath, expected] of Object.entries(table)) {
    const data = entries.get(relPath);
    if (data === undefined) {
      missing.push(relPath);
      continue;
    }
    if (sha256Hex(data) !== expected) mismatches.push(relPath);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/**
 * 冲突决策（applyItemResolution）已抽到 `./conflict-decisions.ts`：
 * 与恢复/回放路径共用同一份语义（回放侧随灾备快照线下线，语义仍是同一条）。
 */

/**
 * 基础路径重定基规则：导出机 DSH home → 本机 DSH home（issue #45 用户补充）。
 *
 * 只在「两边的规范化路径都是绝对路径、且不相同」时生成；两侧都去掉尾部分隔符后比较，
 * 避免 /opt/.dsh/ 与 /opt/.dsh 被判成不同而白跑一次全量替换。前缀匹配仍由 applyPrefixMappings
 * 负责（必须落在段边界），所以 /opt/.dsh 不会误伤 /opt/.dsh-extra。
 *
 * @returns 映射规则；不需要重定基（缺 sourceHome / 相同 / 相对路径）→ undefined
 */
export function rebaseMapping(sourceHome: string | undefined, localHome: string): PathMapping | undefined {
  if (sourceHome === undefined || sourceHome === '') return undefined;
  const strip = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const from = strip(sourceHome);
  const to = strip(localHome ?? '');
  if (from === '' || to === '' || from === to) return undefined;
  const isAbsolute = (value: string): boolean => value.startsWith('/') || /^[a-zA-Z]:[\/]/.test(value);
  if (!isAbsolute(from) || !isAbsolute(to)) return undefined;
  return { oldPrefix: from, newPrefix: to, appliesTo: [] };
}

/**
 * 会话单元版本查询：探针的单元键（`projectKey/会话目录`）与计划项单元 id
 * （`sessions:projectKey/会话目录`）是两个键空间，必须两种形态都试。
 *
 * 为什么不在探针里直接带上适配器前缀：探针只认「分区内的相对路径」，它不知道也不该知道
 * 哪个适配器在消费它（core 也不得 import 会话字节工具）。键空间对齐因此落在计划生成期。
 */
export function sessionUnitVersion(byUnit: ReadonlyMap<string, number>, unitId: string): number | undefined {
  const direct = byUnit.get(unitId);
  if (direct !== undefined) return direct;
  const prefix = 'sessions:';
  const bare = unitId.startsWith(prefix) ? unitId.slice(prefix.length) : prefix + unitId;
  return byUnit.get(bare);
}

/** 路径映射合并：只保留「已解析」（newPrefix 非空）的映射用于执行期数据改写；
 * 未解决项（newPrefix 空）保留在 plan.items 里供 UI 提示，但不参与数据映射。 */
export function mergePathMappings(items: PlanItem[], userMappings: PathMapping[]): PathMapping[] {
  const merged = new Map<string, PathMapping>();
  for (const m of userMappings) {
    if (m.newPrefix !== '') merged.set(m.oldPrefix, m);
  }
  return [...merged.values()];
}

/**
 * 把映射应用到分区数据（PathMapper 先行：只替换匹配前缀的字符串叶值）。
 *
 * `fileCollectionIds` 里的分区一律跳过：`FileCollectionAdapter` 把 `relativePath` 当落盘路径用，
 * 它必须逐字保留（issue #45 ④：改写会话文件的相对路径会让目标机下次启动直接报
 * `corrupt session log`；pluginFiles/skills 等同理——丢位置等于丢归属）。
 * 映射在这些分区上**没有任何合法作用**：文件内容存的是字节（`Uint8Array` 叶子），不会被改。
 */
export function applyMappingsToSections(
  sections: Map<SectionId, unknown>,
  mappings: PathMapping[],
  fileCollectionIds: ReadonlySet<string> = new Set(),
): void {
  if (mappings.length === 0) return;
  for (const [sectionId, data] of sections) {
    if (fileCollectionIds.has(sectionId)) continue;
    const appliesTo: PathMapping['appliesTo'] =
      sectionId === 'workspaces' ? ['workspaces']
        : sectionId === 'mcp' ? ['mcp']
          : sectionId === 'skills' ? ['skills']
            : sectionId === 'pluginFiles' ? ['pluginConfig']
              : [];
    const relevant = mappings.filter((m) => m.appliesTo.some((a) => appliesTo.includes(a as never)) || m.appliesTo.length === 0);
    if (relevant.length === 0) continue;
    sections.set(sectionId, applyPrefixMappings(data, relevant));
  }
}

/** 路径形态判定：跨平台盘符/UNIX 冲突 → platformMismatch；其余绝对路径 → missing（需映射） */
export function detectPathIssues(
  sourcePlatform: string,
  targetPlatform: string,
  sections: Map<SectionId, unknown>,
): PathIssue[] {
  const issues: PathIssue[] = [];
  const workspaces = sections.get('workspaces') as { workspaces?: { path?: string }[] } | undefined;
  for (const w of workspaces?.workspaces ?? []) {
    const p = w.path;
    // section：如实标注来源分区，供导入向导按「本次会写盘的分区」过滤（见 PathIssue.section）
    if (p && isAbsolutePath(p)) issues.push({ ...judgePath(p, sourcePlatform, targetPlatform), section: 'workspaces' });
  }
  const mcp = sections.get('mcp') as { servers?: { serverName?: string; command?: string; cwd?: string }[] } | undefined;
  for (const s of mcp?.servers ?? []) {
    for (const p of [s.cwd, s.command]) {
      if (p && isAbsolutePath(p)) issues.push({ ...judgePath(p, sourcePlatform, targetPlatform), section: 'mcp' });
    }
  }
  // 去重
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.kind}:${i.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function judgePath(p: string, sourcePlatform: string, targetPlatform: string): PathIssue {
  const isWinStyle = /^[a-zA-Z]:[\\/]/.test(p);
  const isUnixStyle = p.startsWith('/');
  if (sourcePlatform !== targetPlatform && ((isWinStyle && targetPlatform !== 'win32') || (isUnixStyle && targetPlatform === 'win32'))) {
    return { kind: 'platformMismatch', value: p };
  }
  return { kind: 'missing', value: p };
}

/**
 * 凭据计划项（MissingSecret / Skip）在**导入路径**上的唯一生成点。
 *
 * ref 来源取**并集**：① credentialsStatus 里 configured=true 的 ref（源机声明「有」，
 * 但普通备份不带值）；② 宿主解密出的归档 ref（`opts.decryptedCredentials`）——
 * 加密备份携带的是 `.credentials.yaml` **原文**，可能含未被任何 settings namespace 引用的 ref
 * （如其它插件自用的 key），只认 ① 会让这些值静默丢掉（真机反馈：导入密钥没生效）。
 *
 * 规则（与同步侧 sync-engine.appendCredentialPlanItems 同口径：**值的有无**优先于本机状态）：
 *  - **有值** → MissingSecret「随加密备份恢复」：用户显式勾了「导出密钥」，导入即写回；
 *    **不因本机已有而跳过**（跳过 = 用户以为密钥导入了、其实没写）。
 *  - **无值**（只有 ref 名）→ 本机已配置 → Skip（保留本机值、不再索要补录，用户报告
 *    「已有的重复密钥也会提示」）；本机没有 → MissingSecret「需要补录」。
 *
 * 凭据值不可回读，因此无值分支一律不覆盖本机已有值。
 *
 * @param decrypted 归档里解出的 ref→值（仅内存；undefined = 未提供密码/无凭据载荷）
 * @param isConfiguredLocally 目标机是否已配置该 ref（读不到 → false，保守按需补录处理）
 */
/**
 * 凭据值「可用」的**唯一判据**（t14 / core-F2 修）：必须是非空字符串。
 *
 * 此前三处各判各的 —— 计划期用 `Map.has()`（空串也算「有值」）、执行期用 `value !== ''`、
 * 结果期又用 `Map.has()`。于是「归档里该 ref 的值为空串」时：计划项说「随加密备份恢复」，
 * 执行静默跳过，结果既不报缺失还把该 ref 算成「已从归档写回」—— 用户看到「导入完成」，
 * 密钥其实没写进去（静默 no-op）。三处必须同源，否则该缺陷会再次以另一种形态复发。
 */
export function usableSecretValue(
  decrypted: ReadonlyMap<string, string> | undefined,
  inputs: Record<string, string> | undefined,
  ref: string,
): boolean {
  const fromArchive = decrypted?.get(ref);
  if (typeof fromArchive === 'string' && fromArchive !== '') return true;
  const fromInput = inputs?.[ref];
  return typeof fromInput === 'string' && fromInput !== '';
}

export async function buildCredentialPlanItems(
  items: PlanItem[],
  sections: Map<SectionId, unknown>,
  decrypted: Map<string, string> | undefined,
  msg: MsgFunc,
  isConfiguredLocally: (ref: string) => Promise<boolean>,
): Promise<void> {
  const creds = sections.get('credentialsStatus') as { credentials?: { ref?: string; configured?: boolean }[] } | undefined;
  const declared: string[] = [];
  for (const c of creds?.credentials ?? []) {
    if (typeof c.ref === 'string' && c.ref !== '' && c.configured === true) declared.push(c.ref);
  }
  const refs = [...new Set([...declared, ...(decrypted?.keys() ?? [])])];
  const existing = new Set(items.map((i) => i.id));
  for (const ref of refs) {
    const id = `secret:${ref}`;
    if (existing.has(id)) continue;
    existing.add(id);
    const target = { adapter: 'credentialsStatus' as const, ref };
    if (usableSecretValue(decrypted, undefined, ref)) {
      items.push({
        id,
        kind: 'MissingSecret',
        adapter: 'credentialsStatus',
        description: msg('import.secretFromArchive', { ref }),
        severity: 'warning',
        target,
      });
      continue;
    }
    if (await isConfiguredLocally(ref)) {
      items.push({
        id,
        kind: 'Skip',
        adapter: 'credentialsStatus',
        description: msg('import.secretAlreadyConfigured', { ref }),
        severity: 'info',
        target,
      });
      continue;
    }
    items.push({
      id,
      kind: 'MissingSecret',
      adapter: 'credentialsStatus',
      description: msg('import.secretMissingDesc', { ref }),
      severity: 'warning',
      target,
    });
  }
}

/* ---------------- F4 删除墓碑过滤（纯函数，可独立测试） ---------------- */

/**
 * 按删除墓碑过滤计划项（F4）：
 *  - 条目级：插件（Install/Update/Conflict）、技能（skills 文件）、文件类条目（agentPresets 等）命中墓碑 → 剔除；
 *  - 分区级：墓碑 kind='section' 且 id=分区 id → 整分区跳过（仅记一条 skipped）。
 * 返回过滤后的 items 与被跳过清单（纯函数：不读文件、不改入参）。
 */
export function applyTombstoneFilter(
  items: PlanItem[],
  tombstones: Tombstone[],
): { items: PlanItem[]; skipped: SkippedTombstone[] } {
  if (tombstones.length === 0) return { items, skipped: [] };

  const tombstonedSections = new Set(tombstones.filter((t) => t.kind === 'section').map((t) => t.id));
  const skipped: SkippedTombstone[] = [];
  const out: PlanItem[] = [];
  const reportedSections = new Set<SectionId>();

  for (const item of items) {
    // 分区级墓碑优先：整个分区不出现（含 Skip 等非写入项，UI 提示「该分区已删除」）
    if (tombstonedSections.has(item.adapter)) {
      if (!reportedSections.has(item.adapter)) {
        skipped.push({ kind: 'section', id: item.adapter, adapter: item.adapter });
        reportedSections.add(item.adapter);
      }
      continue;
    }
    const key = tombstoneKeyForItem(item);
    if (key !== null && isTombstoned(key.kind, key.id, tombstones)) {
      skipped.push({ kind: key.kind, id: key.id, adapter: item.adapter });
      continue;
    }
    out.push(item);
  }
  return { items: out, skipped };
}

/** PlanItem → 墓碑键（{kind,id}）映射；非「将写入」的条目（Skip 等）与配置类项返回 null 不过滤 */
export function tombstoneKeyForItem(item: PlanItem): { kind: TombstoneKind; id: string } | null {
  // 插件本体（plugin:<pkg>）：Install / Update / Conflict 均视为「将写入该插件」→ 命中墓碑剔除；
  // issue #95 的 Create = 「把 host 自带的层声明进 dsh.profile.bundles」，同样是写入该插件，
  // 必须一起被墓碑剔除（用户删过的插件不得被一份旧备份重新声明回来）。
  // patch: 行与 plugins:pnpm-workspace 是配置类项，不按插件墓碑过滤（分区级墓碑可覆盖）。
  if (item.adapter === 'plugins' && item.id.startsWith('plugin:')) {
    if (item.kind !== 'Install' && item.kind !== 'Update' && item.kind !== 'Conflict' && item.kind !== 'Create') return null;
    return { kind: 'plugin', id: item.id.slice('plugin:'.length) };
  }
  // 文件类分区条目（id = <分区>:<相对路径>）：skills → skill 墓碑；其余文件类（agentPresets/
  // agentInstructions/pluginFiles/sessions/self）→ 通用 file 墓碑（id 为相对路径）。
  if (item.kind === 'Create' || item.kind === 'Update' || item.kind === 'Conflict') {
    const prefix = `${item.adapter}:`;
    if (item.adapter === 'skills') return { kind: 'skill', id: item.id.slice(prefix.length) };
    if (isFileSection(item.adapter)) return { kind: 'file', id: item.id.slice(prefix.length) };
  }
  return null;
}
