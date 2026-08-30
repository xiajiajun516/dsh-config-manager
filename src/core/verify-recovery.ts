/**
 * Phase 5 Post-Recovery Verification（§6）。
 *
 * 职责：recovery/rollback 完成后，验证目标状态与 trusted snapshot 匹配。
 * 核心不变量（VERIFIED）：**No recovery/rollback may be considered complete until the
 * target state is verified to match the trusted snapshot** —— 验证失败不能 COMMITTED。
 *
 * 关键规则（§6.2 / §6.3 / §11.1）：
 *  - **verify 时刻重验**：不信任 execute 时「已校验过」的结论（TOCTOU 窗口，快照可能被替换）。
 *    本函数在 verify 时刻重跑完整 `validateSnapshotForRestore`（含 symlink + provenance +
 *    env binding + `requireOperationBound=true`），并从磁盘重读 snapshot.json 作为权威。
 *  - **只消费 TRUSTED_OPERATION_SNAPSHOT**：非 operation-bound（TRUSTED_MANUAL_LOCAL /
 *    LEGACY_REQUIRES_CONFIRMATION）一律拒绝，绝不当作 MATCH。
 *  - **verdict 语义严格区分**：
 *      MATCH            目标状态与 snapshot 完全匹配
 *      PARTIAL_MATCH    核心可验证状态匹配，但存在无法可靠验证的部分（如凭据值不可回读）
 *      MISMATCH         能确定目标状态仍不同于 snapshot（文件 hash 不匹配 / 应删仍存在 /
 *                       plugin/settings 明确不同）
 *      VERIFICATION_ERROR 验证过程本身无法可靠完成（快照重验失败 / fs 读错误 / 异常）
 *    绝不把 VERIFICATION_ERROR 降级成 PARTIAL_MATCH。
 *  - 输出结构兼容 Step 2 的 `recoveryVerification`（verdict/details[]/manualHints[]/at）；
 *    details/manualHints 写入 journal 前由调用方过 `redactJournalText`（本函数只产出文本，
 *    不含 secret 值——凭据值不可回读，settings 只比对不输出值）。
 *
 * 本模块为纯函数（fs 经 node:fs + HostContext 门面注入），可独立测试。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolveFileTarget } from './backup.ts';
import { validateSnapshotForRestore } from './restore.ts';
import type { RecoveryVerification, RecoveryVerificationVerdict } from './journal.ts';
import type { HostContext, Snapshot } from './types.ts';
import type { SectionId } from '../schema/types.ts';

export interface VerifyRecoveryOptions {
  /** 快照根目录（<snapshotsDir>，<snapshotDir> 的直接父级）。 */
  snapshotsRoot: string;
  /** 当前环境指纹（必须与 snapshot binding 一致，否则 WRONG_ENVIRONMENT）。 */
  environmentFingerprint: string;
  /** 期望的 operationId（journal.operationId）。快照 operationId 必须与之双向一致，否则 WRONG_OPERATION。 */
  expectedOperationId?: string;
}

/** 越界防御：abs 必须等于 homeDir 或在 homeDir 之内 */
function isWithinHome(homeDir: string, abs: string): boolean {
  const root = path.resolve(homeDir);
  return abs === root || abs.startsWith(root + path.sep);
}

/** 绝对路径 → 相对 homeDir（跨平台归一为 / 分隔；越界返回空串） */
function toRelPath(homeDir: string, abs: string): string {
  if (!isWithinHome(homeDir, abs)) return '';
  return path.relative(homeDir, abs).split(path.sep).join('/');
}

/** 快照目录内 blob 绝对路径（防 snapshot.json 里伪造 ../ 越界读） */
function blobAbs(snapshotDir: string, blobPath: string): string {
  const abs = path.resolve(snapshotDir, blobPath);
  if (!isWithinHome(snapshotDir, abs)) throw new Error(`blob 路径越界: ${blobPath}`);
  return abs;
}

/** Uint8Array 字节级相等 */
function bufEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** file 类条目的目标绝对路径（复用 backup.ts 的基准目录规则；仅读 homeDir） */
function resolveFileAbs(homeDir: string, adapter: SectionId, ref: string): string {
  return resolveFileTarget({ homeDir } as unknown as HostContext, adapter, ref);
}
/**
 * Post-recovery verification（§6.4）。
 *
 * @param snapshot 被恢复 operation 的 journal 引用快照（id + binding 用于定位与交叉校验；
 *                 实际校验以磁盘重读为准，不信任内存对象）。
 * @param ctx      HostContext（homeDir / fs / settings / plugins 门面）。
 * @param opts     snapshotsRoot + environmentFingerprint。
 */
export async function verifyRecovery(
  snapshot: Snapshot,
  ctx: HostContext,
  opts: VerifyRecoveryOptions,
): Promise<RecoveryVerification> {
  const details: string[] = [];
  const manualHints: string[] = [];
  const at = new Date().toISOString();
  const snapshotDir = path.join(opts.snapshotsRoot, snapshot.id);

  // 1) verify 时刻重验快照（TOCTOU）：重跑完整 validateSnapshotForRestore，requireOperationBound=true。
  //    只接受 TRUSTED_OPERATION_SNAPSHOT；任何其它 verdict（含 TRUSTED_MANUAL_LOCAL / LEGACY）→ VERIFICATION_ERROR。
  const val = await validateSnapshotForRestore(snapshotDir, opts.snapshotsRoot, {
    environmentFingerprint: opts.environmentFingerprint,
  });
  if (val.verdict !== 'TRUSTED_OPERATION_SNAPSHOT') {
    return {
      verdict: 'VERIFICATION_ERROR',
      details: [`快照重验失败: ${val.verdict}${val.reason ? ` — ${val.reason}` : ''}`],
      manualHints: [],
      at,
    };
  }
  details.push('快照重验通过（TRUSTED_OPERATION_SNAPSHOT）');

  // 2) 从磁盘重读 snapshot.json 作为权威（不信任传入的 snapshot 对象，防 execute→verify 间替换）。
  let diskSnapshot: Snapshot;
  try {
    const raw = await fs.readFile(path.join(snapshotDir, 'snapshot.json'), 'utf8');
    diskSnapshot = JSON.parse(raw) as Snapshot;
  } catch (err) {
    return { verdict: 'VERIFICATION_ERROR', details: [...details, `snapshot.json 重读失败: ${err instanceof Error ? err.message : String(err)}`], manualHints: [], at };
  }

  // 3) environment binding（validateSnapshotForRestore 已查，此处双保险）
  if (diskSnapshot.environmentFingerprint && diskSnapshot.environmentFingerprint !== opts.environmentFingerprint) {
    return { verdict: 'VERIFICATION_ERROR', details: [...details, 'environmentFingerprint 不匹配（WRONG_ENVIRONMENT）'], manualHints: [], at };
  }

  // 3b) operation binding（journal.operationId ↔ snapshot.operationId 双向一致；WRONG_OPERATION 拒绝）
  if (opts.expectedOperationId !== undefined && diskSnapshot.operationId !== opts.expectedOperationId) {
    return { verdict: 'VERIFICATION_ERROR', details: [...details, `operationId 不匹配（WRONG_OPERATION）: snapshot=${diskSnapshot.operationId ?? '(无)'} expected=${opts.expectedOperationId}`], manualHints: [], at };
  }

  let mismatch = false;
  let unverifiable = false;

  // 4) host files（hostFileBackups）：existed=true 应存在且内容 hash 匹配 blob；existed=false 应不存在。
  //    经 ctx.fs（HostContext 注入，homeDir 相对）读写，与 rollback.ts 一致。
  for (const backup of diskSnapshot.hostFileBackups ?? []) {
    const rel = backup.relPath;
    if (backup.existed) {
      if (backup.blobPath === '') {
        unverifiable = true;
        details.push(`host file 无 blob 信息: ${rel}`);
        continue;
      }
      if (!(await ctx.fs.exists(rel))) {
        mismatch = true;
        details.push(`host file 缺失: ${rel}`);
        continue;
      }
      let blob: Uint8Array;
      try {
        blob = await fs.readFile(blobAbs(snapshotDir, backup.blobPath));
      } catch {
        unverifiable = true;
        details.push(`host file blob 读取失败: ${rel}`);
        continue;
      }
      const current = await ctx.fs.readFile(rel);
      if (!bufEq(current, blob)) {
        mismatch = true;
        details.push(`host file 内容不匹配: ${rel}`);
      } else {
        details.push(`host file 匹配: ${rel}`);
      }
    } else {
      // snapshot expects absent → target 必须不存在（删除动作失败 → 残留被检测）
      if (await ctx.fs.exists(rel)) {
        mismatch = true;
        details.push(`应删除目标仍存在: ${rel}`);
      } else {
        details.push(`删除目标已不存在: ${rel}`);
      }
    }
  }

  // 5) file 类条目（entries kind='file'）：existed=true 应存在且内容匹配 blob；existed=false 应不存在。
  for (const entry of diskSnapshot.entries ?? []) {
    if (entry.kind !== 'file') continue;
    const rel = toRelPath(ctx.homeDir, resolveFileAbs(ctx.homeDir, entry.adapter, entry.ref));
    if (rel === '') {
      unverifiable = true;
      details.push(`file 路径越界: ${entry.adapter}:${entry.ref}`);
      continue;
    }
    if (entry.existed && entry.copiedTo) {
      if (!(await ctx.fs.exists(rel))) {
        mismatch = true;
        details.push(`file 缺失: ${entry.adapter}:${entry.ref}`);
        continue;
      }
      let blob: Uint8Array;
      try {
        blob = await fs.readFile(blobAbs(snapshotDir, entry.copiedTo));
      } catch {
        unverifiable = true;
        details.push(`file blob 读取失败: ${entry.adapter}:${entry.ref}`);
        continue;
      }
      const current = await ctx.fs.readFile(rel);
      if (!bufEq(current, blob)) {
        mismatch = true;
        details.push(`file 内容不匹配: ${entry.adapter}:${entry.ref}`);
      } else {
        details.push(`file 匹配: ${entry.adapter}:${entry.ref}`);
      }
    } else if (!entry.existed) {
      if (await ctx.fs.exists(rel)) {
        mismatch = true;
        details.push(`应删除 file 目标仍存在: ${entry.adapter}:${entry.ref}`);
      } else {
        details.push(`删除 file 目标已不存在: ${entry.adapter}:${entry.ref}`);
      }
    }
  }

  // 6) plugin state（best-effort）：导入期间新增插件应被移除。可精确验证 → 纳入 MATCH 判断；
  //    无法可靠验证（无基线 / listInstalled 失败）→ PARTIAL_MATCH + manualHint。
  const beforePlugins = diskSnapshot.beforePlugins;
  if (beforePlugins === undefined) {
    unverifiable = true;
    details.push('快照无 beforePlugins 基线，插件状态不可验证');
    manualHints.push('插件状态无法自动验证（快照无基线），请人工确认已装插件');
  } else {
    try {
      const current = await ctx.plugins.listInstalled();
      const beforeNames = new Set(beforePlugins.map((p) => p.name));
      const added = current.filter((p) => !beforeNames.has(p.name));
      if (added.length > 0) {
        mismatch = true;
        details.push(`导入期间新增插件未移除: ${added.map((p) => p.name).join(', ')}`);
      } else {
        details.push('插件状态匹配（无新增插件）');
      }
    } catch {
      unverifiable = true;
      details.push('插件状态无法验证（listInstalled 失败）');
      manualHints.push('插件状态无法自动验证（listInstalled 失败），请人工确认已装插件');
    }
  }

  // 7) settings（best-effort）：settingsNamespace 条目 before 值应与当前 settings 一致。
  const settingsEntries = (diskSnapshot.entries ?? []).filter((e) => e.kind === 'settingsNamespace');
  for (const entry of settingsEntries) {
    try {
      const current = await ctx.settings.describe(entry.ref);
      if (!isDeepStrictEqual(current.value, entry.before)) {
        mismatch = true;
        details.push(`settings 不匹配: ${entry.ref}`);
      } else {
        details.push(`settings 匹配: ${entry.ref}`);
      }
    } catch {
      unverifiable = true;
      details.push(`settings 无法验证: ${entry.ref}`);
      manualHints.push(`settings 无法自动验证（${entry.ref}），请人工确认`);
    }
  }

  // 8) verdict：MISMATCH 优先（能确定目标状态不同）；其次 PARTIAL_MATCH（存在不可验证项）；否则 MATCH。
  if (mismatch) return { verdict: 'MISMATCH', details, manualHints, at };
  if (unverifiable) return { verdict: 'PARTIAL_MATCH', details, manualHints, at };
  return { verdict: 'MATCH', details, manualHints, at };
}

/** 便捷：把 RecoveryVerification 映射为 journal 终态（供 verify 路由单次原子 update 使用）。 */
export function recoveryTerminalState(verdict: RecoveryVerificationVerdict): 'ROLLED_BACK' | 'RECOVERED' | 'NEEDS_ATTENTION' {
  if (verdict === 'MATCH' || verdict === 'PARTIAL_MATCH') return 'ROLLED_BACK';
  return 'NEEDS_ATTENTION';
}
