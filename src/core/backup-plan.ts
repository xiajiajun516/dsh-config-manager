/**
 * 离线文件级备份计划（CLI `backup`）：把 $DSH_HOME 下**离线可直读**的配置打成
 * 与 GUI 导出同结构的 ZIP（manifest.json + integrity/checksums.json + 分区目录）。
 *
 * ## 为什么是「文件级」
 * CLI 的硬约束是**绝不 import `@deepseek-ai/*`**（README 明示：peer 缺失也能跑）。
 * 结构化分区（settings/ui/providers/plugins/mcp/prompts/workspaces/credentialsStatus）
 * 必须经 DSH Service 门面（HostContext）读值，离线根本拿不到；而文件类分区
 * （skills / agentPresets / agentInstructions / pluginFiles / self）在磁盘上**本来就是
 * 真实文件**，因此离线可完整收集并原样重建。
 *
 * 本模块**不伪造**结构化分区载荷：读不到的分区一律不进归档、manifest 标记 false，
 * 并在报告里显式列为不可用（宁可如实告知，也不给一个「声称含设置、实际为空」的
 * 假备份——那会让恢复者以为配置已经保住）。
 *
 * ## 产物兼容性
 * ZIP 内路径直接复用 `schema/config.ts` 的 `SECTION_FILE_PREFIXES`，
 * manifest / checksums 复用 `schema/manifest.ts` + `utils/hashing.ts` 的同一构造方式，
 * 因此产物可被 GUI 导入向导按既有格式解析。
 *
 * ## relativePath 语义（与各 adapter 严格一致）
 * 各 adapter 的 `relativePath` 是**相对其 baseDir** 的路径（见
 * `adapters/file-collection.ts`：导出时把 home 相对路径裁掉 baseDir 前缀）。因此
 * 归档条目名 = `SECTION_FILE_PREFIXES[section] + (homeRel 去掉 baseDir 前缀)`，
 * 导入时 `path.join(baseDir, relativePath)` 才能精确还原原位置。
 *
 * ## 安全不变量（与 README「默认不含任何密钥」硬规则一致）
 *  - 凭据类文件（`.credentials.*` / `.env` / `*.pem` 等）**显式黑名单排除**；
 *  - 只收集白名单目录与显式文件，**绝不对 homeDir 整目录递归**；
 *  - 只收普通文件：特殊文件（设备/FIFO/套接字）一律跳过；**目录 junction / 符号链接
 *    会被跟随**（issue #37：与 GUI 导出同一内核 `utils/recursive-walk.ts`），
 *    目标越出 homeDir 或断链的链接跳过但**写进 warnings**——绝不静默少收内容；
 *    普通目录**超过层级上限**同样留痕（cli-F2），且告警措辞按**真实来源**分派（t37：链接类 vs 目录超深）；
 *  - 命中 `isReservedInternalRel` 的内部命名空间（locks/snapshots/transactions…）跳过；
 *  - 运行时依赖目录 node_modules（任意深度）**整棵跳过**（issue #76：与 plugins 分区的 npm pack 同口径，
 *    依赖树可由包内 package.json / lock 重建），跳过了哪些目录、各多少文件一律写进 warnings；
 *  - `pluginFiles`（`dsh-ssh.json` 等第三方插件自有文件）**默认不收**：该分区与 GUI
 *    侧同为 deviceSpecific「任意文件直通、无内容过滤」，`dsh-ssh.json` 里是明文主机
 *    密码——必须由用户显式 `--sections pluginFiles` 选中，并附带显式告警
 *    （与 GUI 侧 defaultIncluded=false + 市场侧 BANNED_MARKET_SECTIONS 的判定一致）。
 *
 * 零 DSH 运行时依赖：仅 `node:fs/promises` + `node:path` + 本仓库零依赖模块。
 */
import { engineMsg } from './messages-core.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listRecursiveFollowingLinks } from '../utils/recursive-walk.ts';
import type { SkippedLink } from '../utils/recursive-walk.ts';
import { normalizePath, isPathSafe, isReservedInternalRel } from '../utils/paths.ts';
import { SECTION_FILE_PREFIXES, SECTION_IDS, requireSectionMeta } from '../schema/config.ts';
import type { SectionId } from '../schema/types.ts';

/**
 * 默认离线备份分区（顺序 = 归档内写入顺序，保证产物可复现）。
 * 均属 GUI 侧 portable + 默认包含语义，且不含整文件秘密。
 */
export const DEFAULT_BACKUP_SECTIONS: readonly SectionId[] = [
  'skills', 'agentPresets', 'agentInstructions', 'self',
] as const;

/**
 * 需**显式选中**才收集的分区（deviceSpecific：文件内容不受控，可能含明文凭据）。
 * 与 GUI 侧 `pluginFiles.defaultIncluded = false` 严格对齐。
 */
export const OPT_IN_BACKUP_SECTIONS: readonly SectionId[] = ['pluginFiles'] as const;

/** 全部可离线收集的分区（默认 ∪ 显式选中） */
export const OFFLINE_BACKUP_SECTIONS: readonly SectionId[] = [
  ...DEFAULT_BACKUP_SECTIONS, ...OPT_IN_BACKUP_SECTIONS,
] as const;

/**
 * 离线 CLI **明确不收集**的分区（第三方插件数据）。
 *
 * 为什么不做：它的收集目标不是静态路径，而是「本机内置来源注册表 + 已安装插件自述声明」推导出来的
 * 区域（见 `core/plugin-data-registry.ts`），还要尊重环境变量覆盖判定 —— 这套判定住在 adapter 里
 * （走 HostContext 门面），而 CLI 的硬约束是**绝不 import DSH 门面**（peer 缺失也要能跑）。
 * 在这里手抄一份区域表会立刻与注册表漂移（正是本文件开头反复说的那类缺陷），所以选择**显式不适用**：
 * 用户显式 `--sections pluginData` 时给一条可执行的提示（改用 GUI 导出/导入），而不是静默不收。
 */
export const OFFLINE_EXCLUDED_SECTIONS: readonly SectionId[] = ['pluginData', 'pluginAssets'] as const;

/**
 * 离线**无法**收集的分区（需要 DSH Service 门面读值/权威脱敏）。仅用于报告与参数校验，
 * 绝不写进归档：这些分区的权威形态是 GUI 导出（经 DSH `describe({redactSecrets:true})`
 * 逐字段脱敏 + 可选加密），离线启发式脱敏做不到同等强度。
 */
export const OFFLINE_UNAVAILABLE_SECTIONS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'workspaces', 'credentialsStatus',
] as const;

// 加载期自检（注册表派生，t30）：三个离线清单里的 id 必须都是**已注册分区**。
// 「离线可收集性」是注册表未建模的另一条轴（要脱离 DSH 读盘收集），故这三份清单仍是显式声明；
// 但拼错 id / 分区改名过去会让该分区「静默永不收集、永不报告」，现在模块加载即失败。
for (const id of [
  ...DEFAULT_BACKUP_SECTIONS, ...OPT_IN_BACKUP_SECTIONS, ...OFFLINE_UNAVAILABLE_SECTIONS,
  ...OFFLINE_EXCLUDED_SECTIONS,
]) {
  requireSectionMeta(id);
}

/**
 * 凭据类文件名黑名单（**整文件即秘密**，绝不进备份）。与 `security/vault.ts` 的
 * `DEFAULT_SENSITIVE_RELS` 同语义（此处独立声明，避免 CLI 传递依赖 `security/vault.ts`
 * 而拉入 FileSystemFacade 面）。
 */
export const SENSITIVE_FILE_BASENAMES: readonly string[] = [
  '.credentials.yaml',
  '.credentials.yml',
  '.credentials.json',
  '.env',
  'secrets.yaml',
  'secrets.yml',
];

/** 敏感扩展名（私钥/证书/密钥库整文件）：即便文件名不含 secret 也不收 */
const SENSITIVE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

/** 文件名是否为凭据类（大小写不敏感；按 basename 判定，防子目录绕过） */
export function isSensitiveFileName(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  if (SENSITIVE_FILE_BASENAMES.some((n) => n.toLowerCase() === base)) return true;
  return SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/**
 * 一个分区的收集定义。
 *  - `baseDir`：该分区 adapter 的基目录（相对 $DSH_HOME；'' = homeDir 根），
 *    决定 relativePath 的裁剪基准（必须与真实 adapter 一致）；
 *  - `dirs` / `files`：**home 相对路径**的收集目标（目录递归 / 固定文件）。
 */
interface SectionCollectSpec {
  baseDir: string;
  dirs?: readonly string[];
  files?: readonly string[];
  /** 报告用：该分区在 GUI 侧的人类可读名 */
  label: string;
  /** 收集该分区时必须提示的风险（第三方插件文件不受控） */
  risk?: string;
}

/** 分区 → 离线收集定义（与各 adapter 的 baseDir / 白名单严格对齐） */
const SECTION_SPECS: Partial<Record<SectionId, SectionCollectSpec>> = {
  // adapters/skills.ts（FileCollectionAdapter，baseDir='skills'）
  skills: { baseDir: 'skills', dirs: ['skills'], label: 'Skills' },
  // adapters/agent-presets.ts（baseDir='.agent-presets'）
  agentPresets: { baseDir: '.agent-presets', dirs: ['.agent-presets'], label: 'Agent Presets' },
  // adapters/agent-instructions.ts（baseDir=''，仅全局 AGENTS.md）
  agentInstructions: { baseDir: '', files: ['AGENTS.md'], label: 'Agent Instructions' },
  // adapters/plugin-files.ts（baseDir=''，默认白名单 + 约定配置目录）——deviceSpecific
  pluginFiles: {
    baseDir: '',
    files: ['dsh-ssh.json', 'pet.json'],
    dirs: ['plugin-config'],
    label: "Other Plugins' Loose Files",
    get risk() { return engineMsg('core.backupPlan.pluginFilesRisk') },
  },
  // adapters/self.ts（baseDir='dsh-config-manager'，SELF_CONFIG_FILES 白名单）
  self: {
    baseDir: 'dsh-config-manager',
    files: [
      'dsh-config-manager/sync/sync-config.json',
      'dsh-config-manager/sync/sync-autosync.json',
      'dsh-config-manager/sync/sync-selection.json',
      'dsh-config-manager/sync/ui-prefs.json',
      'dsh-config-manager/sync/backup-schedule.json',
      'dsh-config-manager/market/market-config.json',
      'dsh-config-manager/exports/.backup-notes.json',
    ],
    label: "This Plugin's Own Config",
  },
};

/** 归档内一个条目（name 为 ZIP 内 posix 相对路径） */
export interface BackupEntry {
  name: string;
  data: Uint8Array;
}

/** 单个分区的收集结果（报告用，无内容） */
export interface SectionCollection {
  sectionId: SectionId;
  label: string;
  /** 实际进归档的条目数 */
  entryCount: number;
  /** 因凭据黑名单 / 保留命名空间 / 非常规文件而排除的数量 */
  excludedCount: number;
  /** 该分区附带的显式风险提示（选中的话输出层必须打印） */
  risk?: string;
}

/** 收集结果（尚未写盘） */
export interface BackupCollection {
  entries: BackupEntry[];
  sections: SectionCollection[];
  warnings: string[];
  /** 实际有内容、需要在 manifest.sections 置 true 的分区 */
  included: SectionId[];
  /** 选中但无内容（未写入）的分区 id */
  empty: SectionId[];
}

/**
 * skippedLinks 条目 → 用户可见告警（t37：cli-F2 的措辞残留）。
 *
 * 为什么必须按 reason 分派措辞：`loop` / `outside-home` / `broken` / `unreadable` 是**链接**特有的
 * 跳过原因；而 `too-deep` 自 cli-F2 起对**普通目录**同样会记录（此前只有链接超深才记）—— 整块内容被
 * 深度上限裁掉时若仍写成「链接未进备份」，用户看到的原因就与真实来源（目录层级超出上限）不符。
 * 措辞里**不编具体层数**：上限常量住在 utils/recursive-walk.ts，本模块不 import 它的私有常量。
 *
 * 路径**不叠加分区前缀**：内核返回的 `s.path` 已是 homeDir 相对路径（含分区目录），再加一层
 * 会打印成 `skills/skills/...`（真机规模探针实测），与相邻的「目录读取失败」行口径也不一致。
 */
function skippedLinkWarning(s: SkippedLink): string {
  const at = engineMsg('core.backupPlan.pathWithReason', { path: s.path, reason: s.reason });
  if (s.reason === 'too-deep') {
    return engineMsg('core.backupPlan.tooDeep', { at });
  }
  return engineMsg('core.backupPlan.linkSkipped', { at });
}

/**
 * 递归列出目录下全部普通文件（**相对 homeDir** 的 posix 路径，已排序）；目录不存在 → 空。
 *
 * issue #37：与 GUI 导出共用 `utils/recursive-walk.ts` —— **跟随**目录 junction / 符号链接，
 * 并把「跟随了多少链接」「哪些链接/目录没进来（及原因）」写进 warnings。
 * 旧实现遇到链接目录直接跳过且零告警，用户拿到的是「成功但缺斤少两」的备份。
 */
async function listFilesRecursive(
  dirAbs: string,
  homeDir: string,
  warnings: string[],
): Promise<string[]> {
  const listing = await listRecursiveFollowingLinks(dirAbs, homeDir);
  for (const s of listing.skippedLinks) {
    warnings.push(skippedLinkWarning(s));
  }
  for (const dir of listing.unreadableDirs) {
    warnings.push(engineMsg('core.backupPlan.dirUnreadable', { dir }));
  }
  // issue #76：运行时依赖目录整棵跳过（内容未进备份）——必须可见，绝不静默。
  for (const dep of listing.skippedDepDirs) {
    const files = dep.files === null
      ? engineMsg('core.backupPlan.countNotMeasured')
      : engineMsg('core.backupPlan.fileCount', { count: dep.files });
    warnings.push(engineMsg('core.backupPlan.depDirSkipped', { path: dep.path, files }));
  }
  if (listing.followedLinks > 0) {
    warnings.push(engineMsg('core.backupPlan.followedLinks', { count: listing.followedLinks }));
  }
  return listing.paths;
}

/** home 相对路径去 baseDir 前缀 → 该分区 adapter 的 relativePath */
function toRelativePath(baseDir: string, homeRel: string): string {
  if (baseDir === '') return homeRel;
  const prefix = `${baseDir}/`;
  return homeRel.startsWith(prefix) ? homeRel.slice(prefix.length) : homeRel;
}

/** `--sections` 取值校验：返回选中分区或可读错误（未知 id 一律拒绝并列出合法值） */
export function parseSectionsArg(raw: string): { ok: true; sections: SectionId[] } | { ok: false; error: string } {
  const parts = raw.split(/[,\uFF0C\s]+/).filter((p) => p !== '');
  if (parts.length === 0) {
    return { ok: false, error: engineMsg('core.backupPlan.sectionsMissingValue') };
  }
  // 显式请求「不支持离线」的分区 → 单独一条可执行提示（不得当成「不存在的分区」）
  const notOffline = parts.filter((p) => (OFFLINE_EXCLUDED_SECTIONS as readonly string[]).includes(p));
  if (notOffline.length > 0) {
    return { ok: false, error: engineMsg('core.backupPlan.sectionNotOffline', { section: notOffline.join(', ') }) };
  }
  const unknown = parts.filter((p) => !(OFFLINE_BACKUP_SECTIONS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: engineMsg('core.backupPlan.unknownSections', { unknown: unknown.join(', '), available: OFFLINE_BACKUP_SECTIONS.join(', ') }),
    };
  }
  // 去重并保持声明顺序，保证产物可复现
  const want = new Set(parts);
  return { ok: true, sections: OFFLINE_BACKUP_SECTIONS.filter((id) => want.has(id)) };
}

/**
 * 收集一次离线备份的全部条目（纯收集，**不写盘**）。
 * `homeDir` 必须为绝对路径；`only` 为空 = 只收集默认分区（显式选中的 opt-in 分区才收集）。
 * 返回的 `entry.name` 一律为已过 `isPathSafe` 的 ZIP 内 posix 相对路径。
 */
export async function collectBackupEntries(
  homeDir: string,
  only: readonly SectionId[] = [],
): Promise<BackupCollection> {
  const entries: BackupEntry[] = [];
  const sections: SectionCollection[] = [];
  const warnings: string[] = [];
  const included: SectionId[] = [];
  const empty: SectionId[] = [];
  const selected = only.length > 0 ? only : DEFAULT_BACKUP_SECTIONS;

  for (const sectionId of selected) {
    const spec = SECTION_SPECS[sectionId];
    if (spec === undefined) continue;
    const prefix = SECTION_FILE_PREFIXES[sectionId] ?? '';

    let collected = 0;
    let excluded = 0;
    const push = (zipName: string, data: Uint8Array): void => {
      if (!isPathSafe(zipName)) {
        warnings.push(engineMsg('core.backupPlan.unsafeEntryName', { name: zipName }));
        excluded += 1;
        return;
      }
      entries.push({ name: zipName, data });
      collected += 1;
    };

    /** 收集一个 home 相对路径的普通文件 */
    const consider = async (homeRel: string): Promise<void> => {
      const norm = normalizePath(homeRel);
      if (isReservedInternalRel(norm) || isSensitiveFileName(norm)) {
        excluded += 1;
        return;
      }
      const abs = path.join(homeDir, ...norm.split('/'));
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch (err) {
        // 不存在 → 静默跳过（按需创建的文件，如 dsh-ssh.json）
        if ((err as { code?: string }).code !== 'ENOENT') {
          warnings.push(engineMsg('core.backupPlan.statFailed', { path: norm, reason: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
      if (!stat.isFile()) {
        excluded += 1;
        return;
      }
      try {
        const data = await fs.readFile(abs);
        push(`${prefix}${toRelativePath(spec.baseDir, norm)}`, new Uint8Array(data));
      } catch (err) {
        warnings.push(engineMsg('core.backupPlan.readFailed', { path: norm, reason: err instanceof Error ? err.message : String(err) }));
      }
    };

    // 1) 固定文件（存在才收）
    for (const homeRel of spec.files ?? []) await consider(homeRel);

    // 2) 递归目录（跟随 junction/符号链接；未跟随的链接与不可读目录写进 warnings）
    for (const dirRel of spec.dirs ?? []) {
      const dirAbs = path.join(homeDir, ...normalizePath(dirRel).split('/'));
      const rels = await listFilesRecursive(dirAbs, homeDir, warnings);
      for (const homeRel of rels) await consider(homeRel);
    }

    sections.push({
      sectionId, label: spec.label, entryCount: collected, excludedCount: excluded,
      ...(spec.risk !== undefined ? { risk: spec.risk } : {}),
    });
    if (collected > 0) {
      included.push(sectionId);
    } else {
      empty.push(sectionId);
      warnings.push(engineMsg('core.backupPlan.sectionEmpty', { section: sectionId }));
    }
  }

  return { entries, sections, warnings, included, empty };
}

/**
 * 把收集结果归纳成 manifest.sections 布尔表（未收集的分区一律 false，绝不虚报）。
 *
 * t30：分区全集由注册表 `SECTION_IDS` 派生，**不再手抄 15 项清单** —— 新增分区无需改本文件，
 * 也不可能因为漏抄某一行而让该分区在 manifest 里凭空消失（缺键 = 按 false 处理 = 恢复侧认为
 * 「备份不含该分区」）。
 */
export function buildSectionFlags(included: readonly SectionId[]): Record<SectionId, boolean> {
  const has = new Set<string>(included);
  const flags = {} as Record<SectionId, boolean>;
  for (const id of SECTION_IDS) flags[id] = has.has(id);
  return flags;
}
