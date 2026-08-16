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
 *  4. file 类条目补偿：skills/agentPresets/pluginFiles/sessions 原文件 blob 写回 /
 *     快照时不存在则删除（与 rollback.ts 语义一致）；
 *  5. credentials：DSH 不回读值 → existed=true 只生成 manualHint，绝不自动改写。
 *
 * settingsNamespace / patchLine 条目由宿主整文件还原覆盖（settings.yaml /
 * cordis.patch.yml）；workspaceRecord 离线无法经 DSH storages 恢复 → 如实提示。
 * 旧快照（无 beforePlugins / hostFileBackups）兼容：缺基线的部分只提示不动作。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveFileTarget } from './backup.ts';
import {
  classifyDshPluginFailure, readInstalled, resolveProfileDir, runDshPlugin,
} from './plugin-cli.ts';
import { parseJsonSafe } from '../utils/json.ts';
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
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  sourceZip: string;
  status?: SnapshotStatus;
  entryCount: number;
  hostFileBackupCount: number;
  beforePluginCount: number;
}

/* ------------------------------------------------------------ 工具 */

/** 快照目录内读取 snapshot.json（深度保护解析） */
async function loadSnapshot(snapshotDir: string): Promise<Snapshot> {
  const parsed = parseJsonSafe(await fs.readFile(path.join(snapshotDir, 'snapshot.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`快照 ${snapshotDir} 的 snapshot.json 不是合法对象`);
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
function homeAbs(homeDir: string, relPath: string): string {
  const abs = path.resolve(homeDir, relPath);
  if (!isWithinHome(homeDir, abs)) throw new Error(`路径越界: ${relPath}`);
  return abs;
}

/** 快照目录内 blob 绝对路径（防 snapshot.json 里伪造 ../ 越界读） */
function blobAbs(snapshotDir: string, blobPath: string): string {
  const abs = path.resolve(snapshotDir, blobPath);
  if (!isWithinHome(snapshotDir, abs)) throw new Error(`blob 路径越界: ${blobPath}`);
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
  await fs.copyFile(absPath, path.join(preDir, `${String(seq).padStart(4, '0')}-${safe}`));
}

/** 默认插件卸载器：官方 dsh plugin remove 通道 + 失败分类诊断 */
async function defaultPluginUninstaller(
  name: string, profileDir: string, profile: string,
): Promise<{ ok: boolean; message?: string }> {
  const result = await runDshPlugin(profileDir, profile, ['remove', name]);
  if (result.exitCode === 0) return { ok: true };
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const failure = classifyDshPluginFailure(output);
  if (failure !== null) {
    return { ok: false, message: `dsh plugin remove ${name} 失败（${failure.code}）：${failure.message}` };
  }
  const tail = output.split('\n').slice(-8).join('\n') || '无输出';
  return { ok: false, message: `dsh plugin remove ${name} 失败（exit ${String(result.exitCode)}）：${tail}` };
}

/* ------------------------------------------------------------ planRestore */

/**
 * 生成恢复动作计划（dry-run 预览的唯一入口；零写入）：
 * 读快照 + 探测当前文件/已装插件状态，输出按执行顺序排列的动作清单。
 */
export async function planRestore(opts: RestoreOptions): Promise<RestorePlan> {
  const { snapshotDir, homeDir, profile } = opts;
  const snapshot = await loadSnapshot(snapshotDir);
  const settingsRel = await resolveSettingsRelPath(homeDir, opts.settingsPath);
  const actions: RestoreAction[] = [];

  // 1) 宿主整文件还原（hostFileBackups）
  const hostBackups = snapshot.hostFileBackups ?? [];
  for (const backup of hostBackups) {
    let abs: string;
    try {
      abs = homeAbs(homeDir, backup.relPath);
    } catch {
      actions.push({
        kind: 'skip',
        description: `宿主文件路径越界，跳过: ${backup.relPath}`,
        target: backup.relPath,
        detail: '快照登记路径越界，拒绝恢复',
      });
      continue;
    }
    const currentExists = await fileExists(abs);
    if (backup.existed) {
      if (backup.blobPath === '') {
        actions.push({
          kind: 'skip',
          description: `宿主文件 ${backup.relPath} 缺少 blob 副本，跳过`,
          target: backup.relPath,
        });
        continue;
      }
      if (!(await fileExists(blobAbs(snapshotDir, backup.blobPath)))) {
        actions.push({
          kind: 'skip',
          description: `宿主文件 ${backup.relPath} 的 blob 缺失，跳过`,
          target: backup.relPath,
        });
        continue;
      }
      actions.push({
        kind: 'hostFileRestore',
        description: `整文件还原 ${backup.relPath}`,
        target: backup.relPath,
        blobPath: backup.blobPath,
        isSettings: backup.relPath === settingsRel,
        detail: currentExists ? '还原前将备份当前文件到 pre-restore/' : '当前文件不存在，直接写入',
      });
    } else if (currentExists) {
      actions.push({
        kind: 'hostFileRemove',
        description: `移除快照时不存在、现已出现的文件 ${backup.relPath}`,
        target: backup.relPath,
        isSettings: backup.relPath === settingsRel,
        detail: '删除前将备份当前文件到 pre-restore/',
      });
    } else {
      actions.push({
        kind: 'skip',
        description: `宿主文件 ${backup.relPath} 快照时不存在且当前也不存在，无动作`,
        target: backup.relPath,
      });
    }
  }

  // settings 覆盖提示：settingsPath 指定的文件未被快照登记 → 无法整文件还原
  if (settingsRel !== undefined && !hostBackups.some((b) => b.relPath === settingsRel)) {
    actions.push({
      kind: 'skip',
      description: `settings 文件 ${settingsRel} 未被快照登记，无法整文件还原`,
      isSettings: true,
      detail: '该快照未备份此 settings 文件（可能当时不存在或宿主未暴露 profile）',
    });
  }

  // 2) 插件撤销：beforePlugins 基线 vs 当前已装 → 导入期间新增
  const profileDir = resolveProfileDir(homeDir, profile);
  const baseline = snapshot.beforePlugins;
  if (baseline === undefined) {
    actions.push({
      kind: 'skip',
      description: '旧快照无 beforePlugins 基线，无法自动卸载插件',
      detail: '请人工核对导入期间新增的插件并逐个移除',
    });
  } else {
    const beforeNames = new Set(baseline.map((p) => p.name));
    const added = Object.keys(readInstalled(profileDir)).filter((name) => !beforeNames.has(name));
    for (const name of added) {
      actions.push({
        kind: 'pluginRemove',
        description: `卸载导入期间新增插件 ${name}`,
        target: name,
        pluginName: name,
        detail: baseline.length === 0 ? '快照基线为空（导入前可能未捕获插件清单），请确认后执行' : undefined,
      });
    }
    if (added.length === 0) {
      actions.push({
        kind: 'skip',
        description: '无导入期间新增插件（当前已装插件 ⊆ 快照基线）',
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
            description: `文件条目路径越界，跳过: ${entry.adapter}:${entry.ref}`,
            target: entry.ref,
          });
          continue;
        }
        const abs = homeAbs(homeDir, rel);
        const currentExists = await fileExists(abs);
        if (entry.existed && entry.copiedTo) {
          if (!(await fileExists(blobAbs(snapshotDir, entry.copiedTo)))) {
            actions.push({
              kind: 'skip',
              description: `文件 ${rel} 的 blob 缺失，跳过`,
              target: rel,
            });
            continue;
          }
          actions.push({
            kind: 'fileRestore',
            description: `还原文件 ${rel}（${entry.adapter}）`,
            target: rel,
            blobPath: entry.copiedTo,
            detail: currentExists ? '还原前将备份当前文件到 pre-restore/' : '当前文件不存在，直接写入',
          });
        } else if (!entry.existed) {
          if (currentExists) {
            actions.push({
              kind: 'fileRemove',
              description: `删除导入写入的文件 ${rel}（${entry.adapter}）`,
              target: rel,
              detail: '删除前将备份当前文件到 pre-restore/',
            });
          } else {
            actions.push({
              kind: 'skip',
              description: `文件 ${rel} 快照时不存在且当前也不存在，无动作`,
              target: rel,
            });
          }
        } else {
          actions.push({
            kind: 'skip',
            description: `文件 ${rel} 缺少 blob 副本信息，跳过`,
            target: rel,
          });
        }
        break;
      }
      case 'credential':
        if (entry.existed) {
          actions.push({
            kind: 'credentialHint',
            description: `凭据 ${entry.ref} 需人工补录`,
            target: entry.ref,
            manualHint: `凭据 "${entry.ref}" 请人工重新填写（DSH 不回读凭据值）`,
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
      description: `${namespaceCount} 条 settings namespace 条目：快照无 settings 整文件备份，离线无法恢复`,
      detail: '需经在线回滚（rollback.ts）或人工核对 settings.yaml',
    });
  }
  if (patchLineCount > 0 && !patchBacked) {
    actions.push({
      kind: 'skip',
      description: `${patchLineCount} 条 patch 行条目：快照无 cordis.patch.yml 整文件备份，离线无法恢复`,
      detail: '需经在线回滚（rollback.ts）或人工核对 patch 文件',
    });
  }
  if (workspaceCount > 0) {
    actions.push({
      kind: 'skip',
      description: `${workspaceCount} 条 workspace 记录条目：离线无法恢复（数据在 DSH storages）`,
      detail: '需经在线回滚（rollback.ts）或人工核对 workspace 注册表',
    });
  }
  if (credentialAbsentCount > 0) {
    actions.push({
      kind: 'skip',
      description: `${credentialAbsentCount} 条凭据快照时未配置：若导入已创建，需人工在 DSH 中删除`,
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
  const preDir = path.join(snapshotDir, 'pre-restore');
  const profileDir = resolveProfileDir(homeDir, profile);
  const uninstaller = opts.pluginUninstaller ?? defaultPluginUninstaller;

  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  };

  let seq = 0;
  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case 'hostFileRestore': {
          const abs = homeAbs(homeDir, action.target!);
          if (await fileExists(abs)) await copyToPreRestore(preDir, abs, action.target!, ++seq);
          const data = await fs.readFile(blobAbs(snapshotDir, action.blobPath!));
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, data);
          report.restored.push(action.target!);
          break;
        }
        case 'hostFileRemove': {
          const abs = homeAbs(homeDir, action.target!);
          if (await fileExists(abs)) {
            await copyToPreRestore(preDir, abs, action.target!, ++seq);
            await fs.rm(abs, { force: true });
          }
          report.restored.push(action.target!);
          break;
        }
        case 'fileRestore': {
          const abs = homeAbs(homeDir, action.target!);
          if (await fileExists(abs)) await copyToPreRestore(preDir, abs, action.target!, ++seq);
          const data = await fs.readFile(blobAbs(snapshotDir, action.blobPath!));
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, data);
          report.restored.push(action.target!);
          break;
        }
        case 'fileRemove': {
          const abs = homeAbs(homeDir, action.target!);
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
            report.failed.push({ item: `plugin:${action.pluginName}`, reason: result.message ?? '卸载失败' });
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
          report.skipped.push(`未知动作 ${String(action.kind)}: ${action.description}`);
      }
    } catch (err) {
      report.failed.push({
        item: action.target ?? action.pluginName ?? action.description,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
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
      });
    } catch {
      // 损坏 / 非快照目录：跳过
    }
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return metas;
}
