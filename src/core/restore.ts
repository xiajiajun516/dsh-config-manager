/**
 * 离线恢复引擎（M2，criterion m2-restore-restores；设计 §8 / 规范 §27）。
 *
 * 与 rollback.ts 的区别：rollback 是导入失败时的自动补偿（在线，经 HostContext
 * 调 DSH 服务）；本模块是用户主动的「恢复到导入前状态」——纯离线，零 DSH 运行时
 * 依赖（仅 node 内置 + 本项目零依赖工具），直接操作文件系统与官方 dsh plugin CLI：
 *
 *  1. 宿主整文件还原：hostFileBackups（settings.yaml / settings.json / 用户层与
 *     profile 层 cordis.patch.yml）的 blob 写回 $DSH_HOME；快照时不存在、现已出现
 *     的文件删除（restore = 还原到快照那一刻的状态，含移除导入期间新增激活行）；
 *  2. pre-restore 双保险：任何覆盖/删除前，把当前文件复制到
 *     <snapshotDir>/pre-restore/（可人工反悔）；
 *  3. 插件撤销：beforePlugins（导入前基线）与当前已装对比 → 导入期间新增的插件
 *     走官方 `dsh plugin --profile <p> remove <pkg>`（runDshPlugin 通道，零新子进程代码）；
 *  4. file 类条目补偿：skills/agentPresets/agentInstructions/pluginFiles/sessions 原文件 blob 写回 /
 *     快照时不存在则删除（与 rollback.ts 语义一致）；
 *  5. credentials：DSH 不回读值 → existed=true 只生成 manualHint，绝不自动改写。
 *
 * settingsNamespace / patchLine 条目由宿主整文件还原覆盖（settings.yaml /
 * cordis.patch.yml）；workspaceRecord 离线无法经 DSH storages 恢复 → 如实提示。
 * 旧快照（无 beforePlugins / hostFileBackups）兼容：缺基线的部分只提示不动作。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveFileTarget, verifySnapshot } from './backup.ts';
import { expectedSessionRefs, sweepGhostSessions } from './ghost-sweep.ts';
import { zhMsg } from './messages.ts';
import type { MsgFunc } from './messages.ts';
import {
  classifyDshPluginFailure, readInstalled, resolveProfileDir, runDshPlugin,
} from './plugin-cli.ts';
import { parseJsonSafe } from '../utils/json.ts';
import { atomicCopyFile, atomicWriteFile } from '../utils/atomic-write.ts';
import type { SectionId } from '../schema/types.ts';
import type { HostContext, Snapshot, SnapshotStatus } from './types.ts';

/* ---------------------------------------------------------------- 类型 */

export type RestoreActionKind =
  | 'hostFileRestore'   // 宿主整文件 blob → 写回 $DSH_HOME
  | 'hostFileRemove'    // 快照时不存在、现已出现的宿主文件 → 删除
  | 'pluginRemove'      // 导入期间新增插件 → dsh plugin remove
  | 'fileRestore'       // file 类条目 blob → 写回原路径
  | 'fileRemove'        // file 类条目快照时不存在 → 删除导入写入的文件
  | 'credentialHint'    // 凭据值不可回读 → 人工补录提示（无自动动作）
  | 'skip';             // 无需动作 / 离线无法处理 / 旧快照缺基线

export interface RestoreAction {
  kind: RestoreActionKind;
  /** 人类可读描述 */
  description: string;
  /** 目标：相对 $DSH_HOME 的 relPath（hostFile/file 类）或插件名（pluginRemove） */
  target?: string;
  /** hostFileRestore/fileRestore：快照内 blob 相对路径（相对 snapshotDir） */
  blobPath?: string;
  /** pluginRemove：插件包名 */
  pluginName?: string;
  /** credentialHint：人工提示文本 */
  manualHint?: string;
  /** 附加说明（旧快照缺基线 / 离线无法恢复等） */
  detail?: string;
  /** 该动作是否对应 settings 主文件（settingsPath 解析出的文件） */
  isSettings?: boolean;
}

export interface RestorePlan {
  snapshotId: string;
  createdAt: string;
  sourceZip: string;
  actions: RestoreAction[];
  summary: {
    hostFileRestores: number;
    hostFileRemoves: number;
    pluginRemoves: number;
    fileRestores: number;
    fileRemoves: number;
    credentialHints: number;
    skips: number;
  };
  /** beforePlugins 基线是否可用（undefined=旧快照无基线 → 不计划任何插件卸载） */
  pluginBaselineConfirmed: boolean;
}

export interface RestoreOptions {
  /** 快照目录 <snapshotsDir>/<id>/（含 snapshot.json 与 blobs/） */
  snapshotDir: string;
  /** $DSH_HOME（默认 ~/.dsh） */
  homeDir: string;
  /** 管理的 DSH profile 名（插件卸载走 profiles/<profile>） */
  profile: string;
  /** 覆盖 settings 文件路径（默认探测 $DSH_HOME/settings.yaml → settings.json） */
  settingsPath?: string;
  /** 注入式插件卸载器（测试用；缺省走 runDshPlugin 官方通道） */
  pluginUninstaller?: (
    name: string, profileDir: string, profile: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** 每项动作执行回调（宿主路由埋点：更新 RunRegistry 进度；index/1-based、total=计划动作数、
   * detail=动作描述。dry-run/planRestore 不触发） */
  onAction?: (info: { index: number; total: number; detail: string }) => void;
  /** 消息翻译器（缺省 zh；宿主按 DSH 应用语言注入） */
  msg?: MsgFunc;
  /**
   * Phase 4 统一恢复校验：快照根目录（<snapshotsDir>，<snapshotDir> 的直接父级）。
   * 提供时，planRestore 顶端强制调用 validateSnapshotForRestore；CORRUPT/INVALID/UNSAFE_PATH/
   * WRONG_ENVIRONMENT 拒绝计划。缺省 = 不强制（兼容旧调用；新入口都应传）。
   */
  snapshotsRoot?: string;
  /** Phase 4 恢复校验时校验环境指纹（不匹配 → WRONG_ENVIRONMENT；缺省不校验）。 */
  environmentFingerprint?: string;
  /**
   * Phase 4 恢复确认策略：缺省允许 LEGACY 显式恢复。若调用方要求「非 operation-bound 一律拒绝」，
   * 可传 'requireOperationBound'。
   */
  requireOperationBound?: boolean;
}

export interface RestoreReport {
  snapshotId: string;
  /** 已还原/已删除的目标（相对 $DSH_HOME） */
  restored: string[];
  /** 已卸载的插件名 */
  removedPlugins: string[];
  /** 需人工处理的提示（凭据补录等） */
  manualHints: string[];
  /** 失败清单 */
  failed: { item: string; reason: string }[];
  /** 跳过项（无动作 / 离线无法处理） */
  skipped: string[];
  /**
   * 幽灵会话（F5 失效归档清理）：快照记录的 sessions 分区会话在磁盘 sessions 目录
   * 已无任何文件（备份有记录、磁盘无文件）。DSH 官方无归档会话 API，降级本地校验，
   * 仅供报告、需人工在 DSH 确认清理；无会话分区/无幽灵时为缺省或空数组。
   */
  ghostSessions?: string[];
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  sourceZip: string;
  status?: SnapshotStatus;
  entryCount: number;
  hostFileBackupCount: number;
  beforePluginCount: number;
  /** 置顶标记（P1-⑧）：置顶快照不参与自动保留清理（最多保留 N 个时的淘汰豁免） */
  pinned?: boolean;
}

/* ------------------------------------------------------------ 工具 */

/** 快照目录内读取 snapshot.json（深度保护解析） */
async function loadSnapshot(snapshotDir: string, msg: MsgFunc): Promise<Snapshot> {
  const parsed = parseJsonSafe(await fs.readFile(path.join(snapshotDir, 'snapshot.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(msg('restore.snapshotInvalid', { dir: snapshotDir }));
  }
  return parsed as Snapshot;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 越界防御：abs 必须等于 homeDir 或在 homeDir 之内 */
function isWithinHome(homeDir: string, abs: string): boolean {
  const root = path.resolve(homeDir);
  return abs === root || abs.startsWith(root + path.sep);
}

/** homeDir 内绝对路径（越界抛错） */
function homeAbs(homeDir: string, relPath: string, msg: MsgFunc): string {
  const abs = path.resolve(homeDir, relPath);
  if (!isWithinHome(homeDir, abs)) throw new Error(msg('restore.pathEscape', { path: relPath }));
  return abs;
}

/** 快照目录内 blob 绝对路径（防 snapshot.json 里伪造 ../ 越界读） */
function blobAbs(snapshotDir: string, blobPath: string, msg: MsgFunc): string {
  const abs = path.resolve(snapshotDir, blobPath);
  if (!isWithinHome(snapshotDir, abs)) throw new Error(msg('restore.blobPathEscape', { path: blobPath }));
  return abs;
}

/** 绝对路径 → 相对 $DSH_HOME（跨平台归一为 / 分隔；越界返回空串） */
function toRelPath(homeDir: string, abs: string): string {
  if (!isWithinHome(homeDir, abs)) return '';
  return path.relative(homeDir, abs).split(path.sep).join('/');
}

/** file 类条目的目标绝对路径（复用 backup.ts 的基准目录规则；仅读 homeDir） */
function resolveFileAbs(homeDir: string, adapter: SectionId, ref: string): string {
  return resolveFileTarget({ homeDir } as unknown as HostContext, adapter, ref);
}

/** settings 文件 relPath：settingsPath 覆盖优先，否则探测 settings.yaml → settings.json */
async function resolveSettingsRelPath(homeDir: string, settingsPath?: string): Promise<string | undefined> {
  if (settingsPath !== undefined && settingsPath !== '') {
    const rel = toRelPath(homeDir, path.resolve(homeDir, settingsPath));
    return rel === '' ? undefined : rel;
  }
  for (const cand of ['settings.yaml', 'settings.json']) {
    if (await fileExists(path.join(homeDir, cand))) return cand;
  }
  return undefined;
}

/** 把当前文件复制到 <snapshotDir>/pre-restore/（双保险，命名含序号防碰撞） */
async function copyToPreRestore(preDir: string, absPath: string, label: string, seq: number): Promise<void> {
  const safe = label.replace(/[\\/:*?"<>|]/g, '_');
  await fs.mkdir(preDir, { recursive: true });
  await atomicCopyFile(absPath, path.join(preDir, `${String(seq).padStart(4, '0')}-${safe}`));
}

/** 默认插件卸载器：官方 dsh plugin remove 通道 + 失败分类诊断 */
async function defaultPluginUninstaller(
  name: string, profileDir: string, profile: string, msg: MsgFunc,
): Promise<{ ok: boolean; message?: string }> {
  const result = await runDshPlugin(profileDir, profile, ['remove', name]);
  if (result.exitCode === 0) return { ok: true };
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const failure = classifyDshPluginFailure(output);
  if (failure !== null) {
    return { ok: false, message: msg('restore.uninstallFailedCode', { name, code: failure.code, message: failure.message }) };
  }
  const tail = output.split('\n').slice(-8).join('\n') || msg('restore.noOutput');
  return { ok: false, message: msg('restore.uninstallFailedExit', { name, code: String(result.exitCode), tail }) };
}

/* -------------------------------------------------- 统一恢复校验（Phase 4 F8/F9/F25） */

/**
 * 快照恢复前可信校验的 verdict（统一供 Host API / ModelTools / CLI / sync rollback 消费）。
 *
 * - TRUSTED_OPERATION_SNAPSHOT：READY + manifest 完整 + blob hash 匹配 + 有 op/env/owner binding。
 *   可授权自动/推荐回滚。
 * - TRUSTED_MANUAL_LOCAL：READY + 完整校验通过，但无 Phase4 binding（如用户手动/pinned 快照）。
 *   可显式手动恢复，不可作 Phase3 自动 recovery 证据。
 * - LEGACY_REQUIRES_CONFIRMATION：旧快照（无 manifest / 无 readiness）。结构/路径校验通过即可显式确认恢复，
 *   绝不可自动恢复。
 * - INVALID / CORRUPT / UNSAFE_PATH / WRONG_ENVIRONMENT：拒绝。
 */
export type RestoreSnapshotVerdict =
  | 'TRUSTED_OPERATION_SNAPSHOT'
  | 'TRUSTED_MANUAL_LOCAL'
  | 'LEGACY_REQUIRES_CONFIRMATION'
  | 'WRONG_ENVIRONMENT'
  | 'CORRUPT'
  | 'INVALID'
  | 'UNSAFE_PATH';

export interface RestoreSnapshotValidation {
  verdict: RestoreSnapshotVerdict;
  reason?: string;
}

/** 递归检查快照目录内关键文件非 symlink（F25：拒绝 symlink 化 metadata/blob 写穿）。 */
async function assertNoSnapshotSymlink(dir: string, rel: string): Promise<string | null> {
  const p = path.join(dir, rel);
  if (!isWithinHome(dir, p)) return `路径越界: ${rel}`;
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) return `symlink 化关键文件: ${rel}`;
    return null;
  } catch {
    // 缺失由 verify/logic 处理（此处不判缺失）
    return null;
  }
}

/**
 * 统一恢复前校验（供 planRestore 顶端对所有 restore 类型强制调用）：
 * 1. isValidSnapshotId（语法）
 * 2. snapshot.json + manifest 存在、id 匹配（结构）
 * 3. verifySnapshot（磁盘重读：metadataHash + blob hashes + 路径安全）→ CORRUPT
 * 4. symlink 检查（snapshot.json / manifest / blobs）→ UNSAFE_PATH
 * 5. readiness + provenance：
 *    - 无 binding 字段（旧快照）→ LEGACY_REQUIRES_CONFIRMATION
 *    - 有 manifest/READY 但无 op binding → TRUSTED_MANUAL_LOCAL
 *    - 有 READY + manifest + op/env/owner binding → TRUSTED_OPERATION_SNAPSHOT
 * 绝不把「不可证明」当成 trusted。
 */
export async function validateSnapshotForRestore(
  snapshotDir: string,
  snapshotsRoot: string,
  env?: { environmentFingerprint?: string },
): Promise<RestoreSnapshotValidation> {
  const id = path.basename(snapshotDir);
  if (!isValidSnapshotId(id)) return { verdict: 'INVALID', reason: 'snapshotId 非法' };

  // 目录边界：snapshotDir 必须紧邻 snapshotsRoot 下的一层
  const rel = path.relative(snapshotsRoot, snapshotDir).split(path.sep).join('/');
  if (rel === '' || rel.includes('/') || !isWithinHome(snapshotsRoot, snapshotDir)) {
    return { verdict: 'INVALID', reason: '快照目录越界或非直接子目录' };
  }

  // 关键文件 symlink 检查（F25）
  for (const f of ['snapshot.json', 'manifest.json']) {
    const s = await assertNoSnapshotSymlink(snapshotDir, f);
    if (s !== null) return { verdict: 'UNSAFE_PATH', reason: s };
  }

  // F25（Review C 强化）：快照目录本身 / blobs 目录若为 (junction) symlink → 拒绝。
  // 真实 Windows junction（目录 reparse point）在 lstat 下 isSymbolicLink===true，但 readdir
  // 只列出【外部目标目录】的普通文件（isSymbolicLink=false）——仅查 blob 子项会漏 junction 逃逸
  // （外部内容经 junction 伪装成本快照 blobs，restore 读侧 fs.readFile 会跟随到外部读取面）。
  const selfDirGuard = await assertNoSnapshotSymlink(snapshotDir, '.');
  if (selfDirGuard !== null) return { verdict: 'UNSAFE_PATH', reason: selfDirGuard };
  const blobsDirGuard = await assertNoSnapshotSymlink(snapshotDir, 'blobs');
  if (blobsDirGuard !== null) return { verdict: 'UNSAFE_PATH', reason: blobsDirGuard };

  // F25（Review C）：blob 目录内任何实体若为 symlink → 拒绝（文档声称覆盖 blobs，须与实现一致）。
  // blob symlink 指向外部文件，restore 读侧 fs.readFile 会跟随；即使内容 hash 恰好匹配，也属越界读取面，拒绝更安全。
  const blobsDir = path.join(snapshotDir, 'blobs');
  const blobEntries = await fs.readdir(blobsDir, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isSymbolicLink(): boolean }>);
  for (const be of blobEntries) {
    if (be.isSymbolicLink()) {
      return { verdict: 'UNSAFE_PATH', reason: `blob 是 symlink: ${be.name}` };
    }
  }

  // 旧快照检测：无 manifest.json 且 snapshot.json 无 readiness → LEGACY（结构/路径校验已在上面通过，
  // verifySnapshot 需要 manifest → 旧快照不能走完整 verify，需显式确认后仅做基本一致校验）。
  const manifestExists = await fs.access(path.join(snapshotDir, 'manifest.json')).then(() => true).catch(() => false);
  let snapshot: Snapshot | null = null;
  try {
    snapshot = parseJsonSafe(await fs.readFile(path.join(snapshotDir, 'snapshot.json'), 'utf8')) as Snapshot;
  } catch {
    /* verifySnapshot 已报缺失 */
  }
  if (snapshot === null || typeof snapshot !== 'object') return { verdict: 'CORRUPT', reason: 'snapshot.json 无法解析' };
  if (!manifestExists && snapshot.readiness === undefined) {
    return { verdict: 'LEGACY_REQUIRES_CONFIRMATION', reason: '旧快照（无 manifest/READY），需显式确认后恢复' };
  }

  // 结构 + 完整性（磁盘重读，不信任内存）
  const v = await verifySnapshot(snapshotsRoot, id);
  if (!v.ok) return { verdict: 'CORRUPT', reason: v.reason };

  // 环境绑定（WRONG_ENVIRONMENT）
  if (env?.environmentFingerprint && snapshot.readiness === 'READY' && snapshot.environmentFingerprint
    && snapshot.environmentFingerprint !== env.environmentFingerprint) {
    return { verdict: 'WRONG_ENVIRONMENT', reason: 'environmentFingerprint 不匹配（可能来自其他机器/安装）' };
  }

  // provenance 分类
  const hasBinding = snapshot.operationId !== undefined || snapshot.environmentFingerprint !== undefined || snapshot.ownerInstanceId !== undefined;
  if (snapshot.readiness === undefined) {
    return { verdict: 'LEGACY_REQUIRES_CONFIRMATION', reason: '旧快照（无 readiness），需显式确认后恢复' };
  }
  if (!hasBinding) {
    return { verdict: 'TRUSTED_MANUAL_LOCAL', reason: '完整性通过，但非 operation-bound（手动/本地快照）' };
  }
  return { verdict: 'TRUSTED_OPERATION_SNAPSHOT', reason: 'READY + manifest 完整 + op/env/owner binding 匹配' };
}


/**
 * 生成恢复动作计划（dry-run 预览的唯一入口；零写入）：
 * 读快照 + 探测当前文件/已装插件状态，输出按执行顺序排列的动作清单。
 */
export async function planRestore(opts: RestoreOptions): Promise<RestorePlan> {
  const { snapshotDir, homeDir, profile } = opts;
  const msg = opts.msg ?? zhMsg;
  // Phase 4 统一恢复校验：若提供 snapshotsRoot，则在生成任何动作前校验快照可信度。
  // 所有 restore 入口（Host API / ModelTools / CLI）都应传 snapshotsRoot → 同一验证强度。
  if (opts.snapshotsRoot !== undefined) {
    const val = await validateSnapshotForRestore(snapshotDir, opts.snapshotsRoot, {
      environmentFingerprint: opts.environmentFingerprint,
    });
    const reject = ['INVALID', 'CORRUPT', 'UNSAFE_PATH', 'WRONG_ENVIRONMENT'].includes(val.verdict);
    const rejectNotTrusted = opts.requireOperationBound === true
      && val.verdict !== 'TRUSTED_OPERATION_SNAPSHOT';
    if (reject || rejectNotTrusted) {
      throw new Error(msg('restore.snapshotUntrusted', { verdict: val.verdict, reason: val.reason ?? '' }));
    }
  }
  const snapshot = await loadSnapshot(snapshotDir, msg);
  const settingsRel = await resolveSettingsRelPath(homeDir, opts.settingsPath);
  const actions: RestoreAction[] = [];

  // 1) 宿主整文件还原（hostFileBackups）
  const hostBackups = snapshot.hostFileBackups ?? [];
  for (const backup of hostBackups) {
    let abs: string;
    try {
      abs = homeAbs(homeDir, backup.relPath, msg);
    } catch {
      actions.push({
        kind: 'skip',
        description: msg('restore.hostSkipEscape', { path: backup.relPath }),
        target: backup.relPath,
        detail: msg('restore.hostSkipEscapeDetail'),
      });
      continue;
    }
    const currentExists = await fileExists(abs);
    if (backup.existed) {
      if (backup.blobPath === '') {
        actions.push({
          kind: 'skip',
          description: msg('restore.hostNoBlobInfo', { path: backup.relPath }),
          target: backup.relPath,
        });
        continue;
      }
      if (!(await fileExists(blobAbs(snapshotDir, backup.blobPath, msg)))) {
        actions.push({
          kind: 'skip',
          description: msg('restore.hostBlobMissing', { path: backup.relPath }),
          target: backup.relPath,
        });
        continue;
      }
      actions.push({
        kind: 'hostFileRestore',
        description: msg('restore.hostRestore', { path: backup.relPath }),
        target: backup.relPath,
        blobPath: backup.blobPath,
        isSettings: backup.relPath === settingsRel,
        detail: currentExists ? msg('restore.backupBeforeWrite') : msg('restore.writeDirect'),
      });
    } else if (currentExists) {
      actions.push({
        kind: 'hostFileRemove',
        description: msg('restore.hostRemove', { path: backup.relPath }),
        target: backup.relPath,
        isSettings: backup.relPath === settingsRel,
        detail: msg('restore.backupBeforeRemove'),
      });
    } else {
      actions.push({
        kind: 'skip',
        description: msg('restore.hostSkipAbsent', { path: backup.relPath }),
        target: backup.relPath,
      });
    }
  }

  // settings 覆盖提示：settingsPath 指定的文件未被快照登记 → 无法整文件还原
  if (settingsRel !== undefined && !hostBackups.some((b) => b.relPath === settingsRel)) {
    actions.push({
      kind: 'skip',
      description: msg('restore.settingsNotBacked', { path: settingsRel }),
      isSettings: true,
      detail: msg('restore.settingsNotBackedDetail'),
    });
  }

  // 2) 插件撤销：beforePlugins 基线 vs 当前已装 → 导入期间新增
  const profileDir = resolveProfileDir(homeDir, profile);
  const baseline = snapshot.beforePlugins;
  if (baseline === undefined) {
    actions.push({
      kind: 'skip',
      description: msg('restore.noBaseline'),
      detail: msg('restore.noBaselineDetail'),
    });
  } else {
    const beforeNames = new Set(baseline.map((p) => p.name));
    const added = Object.keys(readInstalled(profileDir)).filter((name) => !beforeNames.has(name));
    for (const name of added) {
      actions.push({
        kind: 'pluginRemove',
        description: msg('restore.pluginRemove', { name }),
        target: name,
        pluginName: name,
        detail: baseline.length === 0 ? msg('restore.pluginRemoveEmptyBaseline') : undefined,
      });
    }
    if (added.length === 0) {
      actions.push({
        kind: 'skip',
        description: msg('restore.noAddedPlugins'),
      });
    }
  }

  // 3) file 类条目补偿 + credentials 提示（聚合计数供报告）
  let namespaceCount = 0;
  let patchLineCount = 0;
  let workspaceCount = 0;
  let credentialAbsentCount = 0;
  for (const entry of snapshot.entries) {
    switch (entry.kind) {
      case 'file': {
        const rel = toRelPath(homeDir, resolveFileAbs(homeDir, entry.adapter, entry.ref));
        if (rel === '') {
          actions.push({
            kind: 'skip',
            description: msg('restore.fileSkipEscape', { adapter: entry.adapter, ref: entry.ref }),
            target: entry.ref,
          });
          continue;
        }
        const abs = homeAbs(homeDir, rel, msg);
        const currentExists = await fileExists(abs);
        if (entry.existed && entry.copiedTo) {
          if (!(await fileExists(blobAbs(snapshotDir, entry.copiedTo, msg)))) {
            actions.push({
              kind: 'skip',
              description: msg('restore.fileBlobMissing', { path: rel }),
              target: rel,
            });
            continue;
          }
          actions.push({
            kind: 'fileRestore',
            description: msg('restore.fileRestore', { path: rel, adapter: entry.adapter }),
            target: rel,
            blobPath: entry.copiedTo,
            detail: currentExists ? msg('restore.backupBeforeWrite') : msg('restore.writeDirect'),
          });
        } else if (!entry.existed) {
          if (currentExists) {
            actions.push({
              kind: 'fileRemove',
              description: msg('restore.fileRemove', { path: rel, adapter: entry.adapter }),
              target: rel,
              detail: msg('restore.backupBeforeRemove'),
            });
          } else {
            actions.push({
              kind: 'skip',
              description: msg('restore.fileSkipAbsent', { path: rel }),
              target: rel,
            });
          }
        } else {
          actions.push({
            kind: 'skip',
            description: msg('restore.fileNoBlobInfo', { path: rel }),
            target: rel,
          });
        }
        break;
      }
      case 'credential':
        if (entry.existed) {
          actions.push({
            kind: 'credentialHint',
            description: msg('restore.credentialHint', { ref: entry.ref }),
            target: entry.ref,
            manualHint: msg('restore.credentialManualHint', { ref: entry.ref }),
          });
        } else {
          credentialAbsentCount += 1;
        }
        break;
      case 'settingsNamespace':
        namespaceCount += 1;
        break;
      case 'patchLine':
        patchLineCount += 1;
        break;
      case 'workspaceRecord':
        workspaceCount += 1;
        break;
      default:
        break;
    }
  }

  // 聚合提示：整文件还原覆盖不了的条目如实说明
  const settingsBacked = hostBackups.some((b) => b.relPath === 'settings.yaml' || b.relPath === 'settings.json');
  const patchBacked = hostBackups.some((b) => b.relPath === 'cordis.patch.yml');
  if (namespaceCount > 0 && !settingsBacked) {
    actions.push({
      kind: 'skip',
      description: msg('restore.nsAggregate', { count: String(namespaceCount) }),
      detail: msg('restore.nsAggregateDetail'),
    });
  }
  if (patchLineCount > 0 && !patchBacked) {
    actions.push({
      kind: 'skip',
      description: msg('restore.patchAggregate', { count: String(patchLineCount) }),
      detail: msg('restore.patchAggregateDetail'),
    });
  }
  if (workspaceCount > 0) {
    actions.push({
      kind: 'skip',
      description: msg('restore.workspaceAggregate', { count: String(workspaceCount) }),
      detail: msg('restore.workspaceAggregateDetail'),
    });
  }
  if (credentialAbsentCount > 0) {
    actions.push({
      kind: 'skip',
      description: msg('restore.credentialAbsentAggregate', { count: String(credentialAbsentCount) }),
    });
  }

  return {
    snapshotId: snapshot.id,
    createdAt: snapshot.createdAt,
    sourceZip: snapshot.sourceZip,
    actions,
    summary: summarizeActions(actions),
    pluginBaselineConfirmed: baseline !== undefined,
  };
}

function summarizeActions(actions: RestoreAction[]): RestorePlan['summary'] {
  const summary: RestorePlan['summary'] = {
    hostFileRestores: 0, hostFileRemoves: 0, pluginRemoves: 0,
    fileRestores: 0, fileRemoves: 0, credentialHints: 0, skips: 0,
  };
  for (const a of actions) {
    switch (a.kind) {
      case 'hostFileRestore': summary.hostFileRestores += 1; break;
      case 'hostFileRemove': summary.hostFileRemoves += 1; break;
      case 'pluginRemove': summary.pluginRemoves += 1; break;
      case 'fileRestore': summary.fileRestores += 1; break;
      case 'fileRemove': summary.fileRemoves += 1; break;
      case 'credentialHint': summary.credentialHints += 1; break;
      case 'skip': summary.skips += 1; break;
    }
  }
  return summary;
}

/* ------------------------------------------------------------ restore */

/**
 * 执行恢复：按计划顺序 整文件还原 → 插件卸载 → file 补偿，
 * 覆盖/删除前全部先复制到 <snapshotDir>/pre-restore/（双保险），
 * 逐项 try/catch（单项失败不拖垮其余），输出诚实报告。
 */
export async function restore(opts: RestoreOptions): Promise<RestoreReport> {
  const plan = await planRestore(opts);
  const { snapshotDir, homeDir, profile } = opts;
  const msg = opts.msg ?? zhMsg;
  const preDir = path.join(snapshotDir, 'pre-restore');
  const profileDir = resolveProfileDir(homeDir, profile);
  const uninstaller = opts.pluginUninstaller
    ?? ((name: string, dir: string, prof: string) => defaultPluginUninstaller(name, dir, prof, msg));

  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  };

  let seq = 0;
  const total = plan.actions.length;
  let actionIndex = 0;
  for (const action of plan.actions) {
    actionIndex += 1;
    opts.onAction?.({ index: actionIndex, total, detail: action.description });
    try {
      switch (action.kind) {
        case 'hostFileRestore': {
          const abs = homeAbs(homeDir, action.target!, msg);
          if (await fileExists(abs)) await copyToPreRestore(preDir, abs, action.target!, ++seq);
          const data = await fs.readFile(blobAbs(snapshotDir, action.blobPath!, msg));
          await atomicWriteFile(abs, data);
          report.restored.push(action.target!);
          break;
        }
        case 'hostFileRemove': {
          const abs = homeAbs(homeDir, action.target!, msg);
          if (await fileExists(abs)) {
            await copyToPreRestore(preDir, abs, action.target!, ++seq);
            await fs.rm(abs, { force: true });
          }
          report.restored.push(action.target!);
          break;
        }
        case 'fileRestore': {
          const abs = homeAbs(homeDir, action.target!, msg);
          if (await fileExists(abs)) await copyToPreRestore(preDir, abs, action.target!, ++seq);
          const data = await fs.readFile(blobAbs(snapshotDir, action.blobPath!, msg));
          await atomicWriteFile(abs, data);
          report.restored.push(action.target!);
          break;
        }
        case 'fileRemove': {
          const abs = homeAbs(homeDir, action.target!, msg);
          if (await fileExists(abs)) {
            await copyToPreRestore(preDir, abs, action.target!, ++seq);
            await fs.rm(abs, { force: true });
          }
          report.restored.push(action.target!);
          break;
        }
        case 'pluginRemove': {
          const result = await uninstaller(action.pluginName!, profileDir, profile);
          if (result.ok) {
            report.removedPlugins.push(action.pluginName!);
          } else {
            report.failed.push({ item: `plugin:${action.pluginName}`, reason: result.message ?? msg('restore.pluginRemoveFailed') });
          }
          break;
        }
        case 'credentialHint':
          report.manualHints.push(action.manualHint ?? action.description);
          break;
        case 'skip':
          report.skipped.push(action.description);
          break;
        default:
          report.skipped.push(msg('restore.unknownAction', { kind: String(action.kind), description: action.description }));
      }
    } catch (err) {
      report.failed.push({
        item: action.target ?? action.pluginName ?? action.description,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // F5 幽灵会话校验（file 类会话条目写回后）：快照记录的会话清单 vs 磁盘 sessions 目录
  // 实际文件，报告失效归档（备份有记录、磁盘无文件）。DSH 无归档会话 API，仅报告不
  // 自动清理；校验失败不拖垮已完成的恢复动作，如实记入 failed。
  try {
    const ghostSessions = await sweepRestoredSessions(snapshotDir, homeDir, msg);
    report.ghostSessions = ghostSessions;
    if (ghostSessions.length > 0) {
      report.skipped.push(
        msg('restore.ghostSweepSummary', { count: String(ghostSessions.length), keys: ghostSessions.join(', ') }),
      );
    }
  } catch (err) {
    report.failed.push({ item: 'ghost-sweep', reason: err instanceof Error ? err.message : String(err) });
  }

  return report;
}

/* ------------------------------------------------------------ 幽灵会话（F5） */

/**
 * 磁盘 sessions 目录实际相对路径清单（相对 <homeDir>/sessions；目录缺失视为空）。
 * 用 node fs 递归列举（离线引擎不依赖 HostContext），分隔符由 sessionKeyOf 归一。
 */
async function listSessionEntries(homeDir: string): Promise<string[]> {
  const base = path.join(homeDir, 'sessions');
  try {
    return await fs.readdir(base, { recursive: true });
  } catch {
    return []; // 目录不存在（无会话分区）→ 空
  }
}

/**
 * 幽灵会话本地校验（F5 降级方案）：
 * 快照记录的 sessions 分区 file 条目（existed=true，恢复后应存在）与磁盘
 * <homeDir>/sessions 实际条目对比，返回「备份有记录、磁盘无文件」的失效会话键。
 * DSH 官方无归档会话 API（core/types.ts 未暴露 archivedSessionIds/unarchive），
 * 故不清理 DSH 归档列表，仅报告供人工确认。
 */
async function sweepRestoredSessions(snapshotDir: string, homeDir: string, msg: MsgFunc): Promise<string[]> {
  const snapshot = await loadSnapshot(snapshotDir, msg);
  const expected = expectedSessionRefs(snapshot.entries ?? []);
  if (expected.length === 0) return [];
  return sweepGhostSessions(expected, await listSessionEntries(homeDir));
}

/* ------------------------------------------------------------ listSnapshots */

/**
 * 扫描快照根目录下每个子目录的 snapshot.json，返回按 createdAt 倒序的元信息。
 * 目录缺失/条目损坏自动跳过（不阻断其他快照）。
 */
export async function listSnapshots(dir: string): Promise<SnapshotMeta[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: SnapshotMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = parseJsonSafe(await fs.readFile(path.join(dir, entry.name, 'snapshot.json'), 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const snapshot = parsed as Snapshot;
      if (typeof snapshot.id !== 'string' || snapshot.id === '') continue;
      metas.push({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        sourceZip: snapshot.sourceZip,
        status: snapshot.status,
        entryCount: snapshot.entries?.length ?? 0,
        hostFileBackupCount: snapshot.hostFileBackups?.length ?? 0,
        beforePluginCount: snapshot.beforePlugins?.length ?? 0,
        pinned: snapshot.pinned === true,
      });
    } catch {
      // 损坏 / 非快照目录：跳过
    }
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return metas;
}

/* ------------------------------------------------------------ 快照管理（P1-⑧） */

/** 快照 id 安全校验（防路径穿越）：字母数字 + - _ .，长度 1-80。 */
export function isValidSnapshotId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id);
}

/** 删除单个快照（手动删除；P1-⑧）。只接受合法 id（防穿越），目标是快照根下的 <id>/ 目录。
 *  不存在视为成功（幂等）。返回是否实际删除。 */
export async function deleteSnapshot(snapshotsDir: string, id: string): Promise<boolean> {
  if (!isValidSnapshotId(id)) {
    throw new Error(`非法快照 id: ${JSON.stringify(id)}`);
  }
  const target = path.join(snapshotsDir, id);
  if (!target.startsWith(path.resolve(snapshotsDir) + path.sep)) {
    throw new Error(`快照路径越界: ${id}`);
  }
  try {
    await fs.stat(target);
  } catch {
    return false; // 不存在 → 幂等成功
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

/** 切换置顶状态（P1-⑧）：置顶快照豁免自动保留清理。重写 <dir>/<id>/snapshot.json 的 pinned 字段。
 *  只接受合法 id；快照不存在抛错。 */
export async function setSnapshotPinned(snapshotsDir: string, id: string, pinned: boolean): Promise<boolean> {
  if (!isValidSnapshotId(id)) {
    throw new Error(`非法快照 id: ${JSON.stringify(id)}`);
  }
  const file = path.join(snapshotsDir, id, 'snapshot.json');
  const resolvedRoot = path.resolve(snapshotsDir) + path.sep;
  if (!file.startsWith(resolvedRoot)) {
    throw new Error(`快照路径越界: ${id}`);
  }
  const snapshot = parseJsonSafe(await fs.readFile(file, 'utf8')) as Snapshot;
  snapshot.pinned = pinned;
  await atomicWriteFile(file, JSON.stringify(snapshot, null, 2));
  return pinned;
}
