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
 *  - 只收普通文件：symlink 与特殊文件一律跳过（备份绝不跟随链接）；
 *  - 命中 `isReservedInternalRel` 的内部命名空间（locks/snapshots/transactions…）跳过；
 *  - `pluginFiles`（`dsh-ssh.json` 等第三方插件自有文件）**默认不收**：该分区与 GUI
 *    侧同为 deviceSpecific「任意文件直通、无内容过滤」，`dsh-ssh.json` 里是明文主机
 *    密码——必须由用户显式 `--sections pluginFiles` 选中，并附带显式告警
 *    （与 GUI 侧 defaultIncluded=false + 市场侧 BANNED_MARKET_SECTIONS 的判定一致）。
 *
 * 零 DSH 运行时依赖：仅 `node:fs/promises` + `node:path` + 本仓库零依赖模块。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePath, isPathSafe, isReservedInternalRel } from '../utils/paths.ts';
import { SECTION_FILE_PREFIXES } from '../schema/config.ts';
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
 * 离线**无法**收集的分区（需要 DSH Service 门面读值/权威脱敏）。仅用于报告与参数校验，
 * 绝不写进归档：这些分区的权威形态是 GUI 导出（经 DSH `describe({redactSecrets:true})`
 * 逐字段脱敏 + 可选加密），离线启发式脱敏做不到同等强度。
 */
export const OFFLINE_UNAVAILABLE_SECTIONS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'workspaces', 'credentialsStatus',
] as const;

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
    label: 'Plugin Files',
    risk: '第三方插件自有文件不受控（dsh-ssh.json 内含明文主机密码等），仅在你确认内容后才应纳入备份',
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
    label: 'Plugin Self Config',
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

/** 递归列出目录下全部**普通文件**（相对 dir 的 posix 路径，已排序）；目录不存在 → 空 */
async function listFilesRecursive(dirAbs: string, warnings: string[], label: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const abs = rel === '' ? dirAbs : path.join(dirAbs, ...rel.split('/'));
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      // 目录不存在 → 视为空（与 GUI adapter「目录不存在视为空」一致，不告警）
      if ((err as { code?: string }).code === 'ENOENT' && rel === '') return out;
      warnings.push(`读取目录失败 / failed to read directory: ${label}${rel === '' ? '' : '/' + rel}（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    for (const d of dirents) {
      const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
      // 只跟普通文件与目录：symlink / 设备 / 套接字一律跳过（备份绝不跟随链接）
      if (d.isDirectory()) queue.push(childRel);
      else if (d.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

/** home 相对路径去 baseDir 前缀 → 该分区 adapter 的 relativePath */
function toRelativePath(baseDir: string, homeRel: string): string {
  if (baseDir === '') return homeRel;
  const prefix = `${baseDir}/`;
  return homeRel.startsWith(prefix) ? homeRel.slice(prefix.length) : homeRel;
}

/** `--sections` 取值校验：返回选中分区或可读错误（未知 id 一律拒绝并列出合法值） */
export function parseSectionsArg(raw: string): { ok: true; sections: SectionId[] } | { ok: false; error: string } {
  const parts = raw.split(/[,，\s]+/).filter((p) => p !== '');
  if (parts.length === 0) {
    return { ok: false, error: '`--sections` 缺值 / missing value for `--sections`' };
  }
  const unknown = parts.filter((p) => !(OFFLINE_BACKUP_SECTIONS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `未知分区 / unknown section(s): ${unknown.join(', ')}（可用 / available: ${OFFLINE_BACKUP_SECTIONS.join(', ')}）`,
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
        warnings.push(`跳过不安全条目名 / unsafe entry name skipped: ${zipName}`);
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
          warnings.push(`探测失败 / stat failed: ${norm}（${err instanceof Error ? err.message : String(err)}）`);
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
        warnings.push(`读取失败 / read failed: ${norm}（${err instanceof Error ? err.message : String(err)}）`);
      }
    };

    // 1) 固定文件（存在才收）
    for (const homeRel of spec.files ?? []) await consider(homeRel);

    // 2) 递归目录
    for (const dirRel of spec.dirs ?? []) {
      const dirAbs = path.join(homeDir, ...normalizePath(dirRel).split('/'));
      const rels = await listFilesRecursive(dirAbs, warnings, dirRel);
      for (const rel of rels) await consider(`${normalizePath(dirRel)}/${rel}`);
    }

    sections.push({
      sectionId, label: spec.label, entryCount: collected, excludedCount: excluded,
      ...(spec.risk !== undefined ? { risk: spec.risk } : {}),
    });
    if (collected > 0) {
      included.push(sectionId);
    } else {
      empty.push(sectionId);
      warnings.push(`分区无内容，未写入 / section empty, skipped: ${sectionId}`);
    }
  }

  return { entries, sections, warnings, included, empty };
}

/** 把收集结果归纳成 manifest.sections 布尔表（未收集的分区一律 false，绝不虚报） */
export function buildSectionFlags(included: readonly SectionId[]): Record<SectionId, boolean> {
  const has = new Set<string>(included);
  const all: SectionId[] = [
    'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'workspaces',
    'skills', 'agentPresets', 'agentInstructions', 'pluginFiles', 'sessions', 'self',
    'credentialsStatus', 'secrets',
  ];
  const flags = {} as Record<SectionId, boolean>;
  for (const id of all) flags[id] = has.has(id);
  return flags;
}
