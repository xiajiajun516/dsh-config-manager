/**
 * 文件级 vault（敏感文件本机镜像，设计参考 dsh-backup 的「文件级 vault」思路）。
 *
 * 动机：字段级 Secret 扫描只能剥离结构化数据里的敏感值；像 .credentials.yaml 这类
 * 「整文件即秘密」的文件，字节明文不进归档、不进同步，而是只镜像到本机
 * <dataDir>/vault/ 目录（vault 目录本身绝不进入导出/同步，与 self 分区白名单互斥），
 * 恢复（如跨机导入）时从 vault 回填 $DSH_HOME；vault 无对应文件（跨机恢复、
 * 从未镜像过）则提示用户重填。比字段级扫描更彻底（整文件隔离）。
 *
 * 纯函数式设计：fs 一律经 FileSystemFacade 参数注入（对齐 core 层解耦原则），
 * 不直接 import node:fs；node 环境可用内存 mock 全量测试。
 * 路径约定：dshHome / dataDir 为绝对路径；敏感文件清单 rel 一律为相对 $DSH_HOME
 * 的斜杠分隔相对路径（与 FileSystemFacade.listRecursive 的 home-relative 产出一致）。
 *
 * 安全不变量：
 *  - vault 内容 = 敏感文件明文，仅存在于本机 dataDir，永不进入 ZIP / 同步 / 日志；
 *  - rel 入参必须通过 isPathSafe（拒绝绝对路径 / .. / 盘符 / NUL），防路径穿越；
 *  - 恢复不覆盖已存在的目标文件（避免覆盖目标机更新后的凭据），缺失项记入 missing。
 *
 * 权限说明：FileSystemFacade 无 chmod 能力（宿主 mkdir 已递归），vault 目录权限
 * 跟随宿主 dataDir 既有策略；Windows 不强制 POSIX 权限位。
 */
import path from 'node:path';
import type { FileSystemFacade } from '../core/types.ts';
import { isPathSafe, normalizePath } from '../utils/paths.ts';

/**
 * 默认敏感文件清单（相对 $DSH_HOME）：当前 DSH 唯一「整文件即秘密」的文件
 * （.credentials.yaml = 凭据明文 token/password/密钥）。
 * 宿主可传入扩展清单（如 profiles/<p>/secrets.yaml、.env 等），默认清单保持最小。
 */
export const DEFAULT_SENSITIVE_RELS: readonly string[] = [
  '.credentials.yaml',
];

/** vault 根目录 = <dataDir>/vault */
export function vaultRootOf(dataDir: string): string {
  return path.join(dataDir, 'vault');
}

/** refreshVault 结果 */
export interface VaultRefreshResult {
  /** 本次实际镜像入库的敏感文件（相对 $DSH_HOME） */
  mirrored: string[];
  /** 因源文件已不存在 / rel 不再属于清单而被清理的旧镜像（相对 $DSH_HOME） */
  cleaned: string[];
  /** 单个文件镜像失败（非致命：读源 / 写镜像异常），reason 为错误消息 */
  skipped: { rel: string; reason: string }[];
}

/** restoreVaultFiles 结果 */
export interface VaultRestoreResult {
  /** 已从 vault 回填到 $DSH_HOME 的文件（相对 $DSH_HOME） */
  restored: string[];
  /** vault 中缺失、需要用户重填的文件（跨机恢复 vault 为空 → 全部缺失） */
  missing: string[];
  /** 跳过项：reason 为 'targetExists'（目标已存在不覆盖）或错误消息（拷贝失败） */
  skipped: { rel: string; reason: string }[];
}

/** listVault 条目 */
export interface VaultEntry {
  /** 原始敏感文件路径（相对 $DSH_HOME） */
  rel: string;
  /** vault 内镜像的绝对路径 */
  vaultPath: string;
}

/** rel 必须为安全相对路径（拒绝绝对路径 / .. / 盘符 / NUL），防路径穿越 */
function assertSafeRel(rel: string): void {
  if (!isPathSafe(rel)) throw new Error(`vault: 非法敏感文件路径 "${rel}"`);
}

/** 校验 + 归一化 rel 清单（统一 / 分隔，与 FileSystemFacade.listRecursive 产出对齐） */
function normalizeRels(rels: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    assertSafeRel(rel);
    out.push(normalizePath(rel));
  }
  return out;
}

/**
 * 刷新 vault：把 $DSH_HOME 下现存敏感文件镜像到 <dataDir>/vault/<rel>。
 * 幂等：重复调用结果一致（同字节覆盖写，不产生重复条目）。
 * 清理：源文件已不存在、或 rel 不再属于传入清单的旧镜像会被删除。
 * 返回实际入库清单（供报告 / 提示「已镜像到本机 vault」）。
 */
export async function refreshVault(
  fs: FileSystemFacade,
  dataDir: string,
  dshHome: string,
  rels: readonly string[],
): Promise<VaultRefreshResult> {
  const normRels = normalizeRels(rels);
  const vaultRoot = vaultRootOf(dataDir);
  await fs.mkdir(vaultRoot); // 宿主 mkdir 递归；失败向上抛（调用方按尽力而为处理）
  const mirrored: string[] = [];
  const skipped: { rel: string; reason: string }[] = [];

  // 1. 镜像现存敏感文件（源不存在则跳过；读/写失败按文件记录，不中断整体）
  for (const rel of normRels) {
    const src = path.join(dshHome, rel);
    const dst = path.join(vaultRoot, rel);
    try {
      if (!(await fs.exists(src))) continue;
      const data = await fs.readFile(src);
      await fs.writeFile(dst, data);
      mirrored.push(rel);
    } catch (err) {
      skipped.push({ rel, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. 清理旧镜像：源已不存在 或 rel 不再属于清单（listRecursive 产出为 home-relative）
  const cleaned: string[] = [];
  try {
    const vaultFiles = await fs.listRecursive(vaultRoot);
    for (const homeRel of vaultFiles) {
      const vaultRel = normalizePath(path.relative(vaultRoot, path.join(dshHome, homeRel)));
      if (vaultRel === '' || vaultRel.startsWith('..') || path.isAbsolute(vaultRel)) continue; // 防御：理论上不会发生
      if (!normRels.includes(vaultRel)) {
        await fs.remove(path.join(vaultRoot, vaultRel));
        cleaned.push(vaultRel);
        continue;
      }
      if (!(await fs.exists(path.join(dshHome, vaultRel)))) {
        await fs.remove(path.join(vaultRoot, vaultRel));
        cleaned.push(vaultRel);
      }
    }
  } catch {
    // 清理是尽力而为：listRecursive / remove 失败不影响镜像结果
  }

  return { mirrored, cleaned, skipped };
}

/**
 * 从 vault 回填敏感文件到 $DSH_HOME（跨机恢复 / 本机误删后的恢复）。
 * 不覆盖已存在的目标文件（安全：避免覆盖目标机更新后的凭据）；
 * vault 无对应文件（跨机恢复、从未镜像过）记入 missing，由调用方提示用户重填。
 */
export async function restoreVaultFiles(
  fs: FileSystemFacade,
  dataDir: string,
  dshHome: string,
  rels: readonly string[],
): Promise<VaultRestoreResult> {
  const normRels = normalizeRels(rels);
  const vaultRoot = vaultRootOf(dataDir);
  const restored: string[] = [];
  const missing: string[] = [];
  const skipped: { rel: string; reason: string }[] = [];

  for (const rel of normRels) {
    const vaultPath = path.join(vaultRoot, rel);
    const target = path.join(dshHome, rel);
    try {
      if (!(await fs.exists(vaultPath))) {
        missing.push(rel);
        continue;
      }
      if (await fs.exists(target)) {
        skipped.push({ rel, reason: 'targetExists' });
        continue;
      }
      await fs.copy(vaultPath, target);
      restored.push(rel);
    } catch (err) {
      skipped.push({ rel, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { restored, missing, skipped };
}

/**
 * 列出 vault 内容（镜像结构 = 相对 $DSH_HOME 的 rel 平铺在 vault 根下，
 * 例如 vault/.credentials.yaml 即 $DSH_HOME/.credentials.yaml 的镜像）。
 * vault 不存在 / 为空时返回空数组。
 */
export async function listVault(
  fs: FileSystemFacade,
  dataDir: string,
  dshHome: string,
): Promise<VaultEntry[]> {
  const vaultRoot = vaultRootOf(dataDir);
  const homeRels = await fs.listRecursive(vaultRoot); // home-relative；vault 不存在时宿主返回 []
  const entries: VaultEntry[] = [];
  for (const homeRel of homeRels) {
    const rel = normalizePath(path.relative(vaultRoot, path.join(dshHome, homeRel)));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue; // 防御
    entries.push({ rel, vaultPath: path.join(vaultRoot, rel) });
  }
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
