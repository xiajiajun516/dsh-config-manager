/**
 * Pre-import Snapshot（规范 §16/§27）：只保存本次导入将被修改的目标原值。
 * 应用层事务的基础：所有补偿动作基于快照（rollback.ts 逆序执行）。
 *
 * 快照不保存 credential 值（DSH 永不回读值）——credential 条目只记 existed 标志，
 * 回滚时 existed=true 的条目如实标记「值需人工补录」。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJsonSafe } from '../utils/json.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { SectionId } from '../schema/types.ts';
import type {
  ConfigAdapter, HostContext, HostFileBackup, ImportPlan, PlanItem, Snapshot,
  SnapshotEntry, SnapshotStatus, SnapshotStore, SnapshotTarget,
} from './types.ts';

/** 导入将实际写入的目标 kinds（这些项才需要快照） */
const EXECUTABLE_KINDS = new Set(['Create', 'Update', 'Install', 'MissingSecret', 'MissingDependency']);

/**
 * 需要整文件备份的宿主关键文件（相对 $DSH_HOME）：
 *  - settings.yaml（DSH 配置主存储；不存在时探测 settings.json）
 *  - cordis.patch.yml（用户 patch 层）
 *  - profiles/<profile>/cordis.patch.yml（profile patch 层，宿主暴露 profile 时）
 */
const HOST_FILE_CANDIDATES: ReadonlyArray<{ relPath: string }> = [
  { relPath: 'settings.yaml' },
  { relPath: 'settings.json' },
  { relPath: 'cordis.patch.yml' },
];

/**
 * 宿主整文件备份（M1）：探测存在性，存在的文件字节进 blobs Map 由 store.save 落盘，
 * 全部候选（含 existed:false）登记进 hostFileBackups，供 M2 restore 整文件还原。
 */
async function backupHostFiles(
  ctx: HostContext,
  blobs: Map<string, Uint8Array>,
): Promise<HostFileBackup[]> {
  const candidates = [...HOST_FILE_CANDIDATES];
  if (ctx.profile !== undefined && ctx.profile !== '') {
    candidates.push({ relPath: `profiles/${ctx.profile}/cordis.patch.yml` });
    // pnpm-workspace.yaml 决定插件能否安装（allowBuilds/冷静期）→ 一并纳入宿主整文件备份
    candidates.push({ relPath: `profiles/${ctx.profile}/pnpm-workspace.yaml` });
  }

  const backups: HostFileBackup[] = [];
  for (const { relPath } of candidates) {
    // settings.yaml 与 settings.json 互斥：主存储存在时不再探测 json 备选
    if (relPath === 'settings.json' && backups.some((b) => b.relPath === 'settings.yaml' && b.existed)) {
      continue;
    }
    let existed = false;
    try {
      existed = await ctx.fs.exists(relPath);
    } catch (err) {
      ctx.log.warn(`快照探测宿主文件失败 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      existed = false;
    }
    if (!existed) {
      backups.push({ relPath, blobPath: '', existed: false });
      continue;
    }
    const blobPath = `blobs/host/${crypto.randomUUID()}`;
    try {
      blobs.set(blobPath, await ctx.fs.readFile(relPath));
      backups.push({ relPath, blobPath, existed: true });
    } catch (err) {
      ctx.log.warn(`快照读取宿主文件失败 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      backups.push({ relPath, blobPath: '', existed: false });
    }
  }
  return backups;
}

/** 文件类分区的目标基准目录（相对 homeDir；pluginFiles 的 ref 已是完整相对路径） */
const FILE_BASES: Partial<Record<SectionId, string>> = {
  skills: 'skills',
  agentPresets: '.agent-presets',
  pluginFiles: '',
  sessions: 'sessions',
};

/** 解析文件类目标的绝对路径（引擎通用快照与回滚共用） */
export function resolveFileTarget(ctx: HostContext, adapter: SectionId, ref: string): string {
  // plugins 分区的 pnpm-workspace.yaml：位于 profiles/<profile>/ 下（非 FILE_BASES 静态基准）
  if (adapter === 'plugins' && ref === 'pnpm-workspace.yaml') {
    const profile = ctx.profile !== undefined && ctx.profile !== '' ? ctx.profile : 'web';
    return path.join(ctx.homeDir, 'profiles', profile, 'pnpm-workspace.yaml');
  }
  const base = FILE_BASES[adapter] ?? '';
  return path.join(ctx.homeDir, base, ref);
}

export interface CreateSnapshotOptions {
  ctx: HostContext;
  plan: ImportPlan;
  sourceZip: string;
  store: SnapshotStore;
  adapters: ConfigAdapter[];
}

/** 从计划中收集将被写入的 target（去重） */
function collectTargets(plan: ImportPlan): SnapshotTarget[] {
  const seen = new Set<string>();
  const targets: SnapshotTarget[] = [];
  for (const item of plan.items) {
    if (!EXECUTABLE_KINDS.has(item.kind) || item.target === undefined) continue;
    const key = `${item.target.adapter}\u0000${item.target.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(item.target);
  }
  return targets;
}

/** 引擎通用快照（adapter 未实现 snapshot? 时兜底） */
async function engineSnapshotEntry(ctx: HostContext, target: SnapshotTarget): Promise<SnapshotEntry> {
  switch (target.adapter) {
    case 'settings':
    case 'ui':
    case 'providers': {
      try {
        const info = await ctx.settings.describe(target.ref);
        return { kind: 'settingsNamespace', adapter: target.adapter, ref: target.ref, before: info.value, revision: info.revision, existed: true };
      } catch {
        // 目标不存在该 namespace → 快照标记 existed:false（回滚时无法恢复「不存在」，如实处理）
        return { kind: 'settingsNamespace', adapter: target.adapter, ref: target.ref, before: null, revision: 0, existed: false };
      }
    }
    case 'credentialsStatus': {
      const info = await ctx.credentials.describe(target.ref);
      return { kind: 'credential', adapter: target.adapter, ref: target.ref, before: null, existed: info.configured };
    }
    case 'workspaces': {
      const records = await ctx.workspace.listRecords();
      const rec = records.find((r) => r.id === target.ref);
      return { kind: 'workspaceRecord', adapter: target.adapter, ref: target.ref, before: rec ?? null };
    }
    case 'mcp':
    case 'plugins':
    case 'prompts': {
      // plugins 分区的 pnpm-workspace.yaml → 整文件快照（file 类，回滚可整文件还原）
      if (target.adapter === 'plugins' && target.ref === 'pnpm-workspace.yaml') {
        const abs = resolveFileTarget(ctx, target.adapter, target.ref);
        if (!(await ctx.fs.exists(abs))) {
          return { kind: 'file', adapter: target.adapter, ref: target.ref, before: null, existed: false };
        }
        const data = await ctx.fs.readFile(abs);
        return {
          kind: 'file',
          adapter: target.adapter,
          ref: target.ref,
          before: { contentHash: sha256Hex(data) },
          existed: true,
          copiedTo: `blobs/${crypto.randomUUID()}`,
        };
      }
      // patchLine：从组合 patch 文件读取原行（file 为必填的 file 字段约定为 'cordis.patch.yml'）
      const file = 'cordis.patch.yml';
      const lines = await ctx.patchFile.readPatchLines(file);
      const line = lines.find((l) => l.lineId === target.ref);
      return { kind: 'patchLine', adapter: target.adapter, ref: target.ref, before: line?.raw ?? null, existed: line !== undefined };
    }
    case 'skills':
    case 'agentPresets':
    case 'pluginFiles':
    case 'sessions': {
      const abs = resolveFileTarget(ctx, target.adapter, target.ref);
      if (!(await ctx.fs.exists(abs))) {
        return { kind: 'file', adapter: target.adapter, ref: target.ref, before: null, existed: false };
      }
      const data = await ctx.fs.readFile(abs);
      // 文件字节不放进 SnapshotEntry（契约纯净），由 createSnapshot 收集进 blobs Map 统一落盘
      return {
        kind: 'file',
        adapter: target.adapter,
        ref: target.ref,
        before: { contentHash: sha256Hex(data) },
        existed: true,
        copiedTo: `blobs/${crypto.randomUUID()}`,
      };
    }
    default:
      return { kind: 'settingsNamespace', adapter: target.adapter, ref: target.ref, before: null };
  }
}

/**
 * 生成并落盘快照：只覆盖将被写入的目标。
 * 文件字节经 blobs Map 交给 store.save（SnapshotEntry 契约不含二进制）。
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<Snapshot> {
  const { ctx, plan, sourceZip, store, adapters } = opts;
  const targets = collectTargets(plan);

  const entries: SnapshotEntry[] = [];
  const blobs = new Map<string, Uint8Array>();

  // 1) 有 adapter.snapshot? 的优先（adapter 更懂自己的数据）
  const byAdapter = new Map<SectionId, SnapshotTarget[]>();
  for (const t of targets) {
    const list = byAdapter.get(t.adapter) ?? [];
    list.push(t);
    byAdapter.set(t.adapter, list);
  }
  for (const adapter of adapters) {
    const adapterTargets = byAdapter.get(adapter.id);
    if (!adapterTargets || adapterTargets.length === 0) continue;
    if (adapter.snapshot) {
      const adapterEntries = await adapter.snapshot(adapterTargets, ctx);
      entries.push(...adapterEntries);
      byAdapter.delete(adapter.id);
    }
  }

  // 2) 引擎通用快照兜底
  for (const [adapterId, remaining] of byAdapter) {
    for (const target of remaining) {
      const entry = await engineSnapshotEntry(ctx, target);
      // 文件字节：文件类条目在引擎快照里读出内容 → blobs
      if (entry.kind === 'file' && entry.copiedTo && entry.existed) {
        const abs = resolveFileTarget(ctx, adapterId, target.ref);
        blobs.set(entry.copiedTo, await ctx.fs.readFile(abs));
      }
      entries.push(entry);
    }
  }

  // 3) 宿主整文件备份（M1）：settings.yaml/settings.json + 用户/ profile 层 cordis.patch.yml
  const hostFileBackups = await backupHostFiles(ctx, blobs);

  // 4) 导入前插件清单（M2 restore 撤销插件对比基准；读取失败不阻断快照）
  let beforePlugins: Snapshot['beforePlugins'] = [];
  try {
    beforePlugins = await ctx.plugins.listInstalled();
  } catch (err) {
    ctx.log.warn(`快照登记插件清单失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip,
    entries,
    status: 'pending',
    beforePlugins,
    hostFileBackups,
  };
  // file 条目登记 snapshotId，回滚读 blob 时定位快照目录
  for (const entry of snapshot.entries) {
    if (entry.kind === 'file') entry.snapshotId = snapshot.id;
  }
  await store.save(snapshot, blobs);
  return snapshot;
}

/* ---------------- 默认文件快照存储 ---------------- */

/** 快照保留上限：save 落盘后超过该数量则删除最旧快照目录 */
export const SNAPSHOT_RETENTION_LIMIT = 10;

/** 纯函数：返回应清理的最旧快照 id（按 createdAt 升序取超限部分；恰好 limit 个 → 空数组）。
 * 参数用最小结构类型，避免引入 restore.ts 的 SnapshotMeta 造成循环 import。 */
export function selectPruneCandidates(
  metas: ReadonlyArray<{ id: string; createdAt: string }>,
  limit: number = SNAPSHOT_RETENTION_LIMIT,
): string[] {
  if (metas.length <= limit) return [];
  const sorted = [...metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return sorted.slice(0, sorted.length - limit).map((m) => m.id);
}

export interface FileSnapshotStoreOptions {
  /** 快照根目录（宿主决定，如 ~/.dsh/dsh-config-manager/snapshots） */
  dir: string;
}

/** 文件快照存储：<dir>/<id>/snapshot.json + <dir>/<id>/blobs/* */
export class FileSnapshotStore implements SnapshotStore {
  private readonly options: FileSnapshotStoreOptions;

  constructor(options: FileSnapshotStoreOptions) {
    this.options = options;
  }

  private snapshotDir(id: string): string {
    return path.join(this.options.dir, id);
  }

  async save(snapshot: Snapshot, blobs: Map<string, Uint8Array> = new Map()): Promise<string> {
    const dir = this.snapshotDir(snapshot.id);
    await fs.mkdir(path.join(dir, 'blobs'), { recursive: true });
    for (const [blobPath, data] of blobs) {
      const target = path.join(dir, blobPath);
      if (!target.startsWith(dir)) throw new Error(`快照 blob 路径越界: ${blobPath}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
    await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    await this.prune();
    return snapshot.id;
  }

  /** 保留清理：扫描快照根目录，超限时删除最旧快照目录（损坏/非快照目录跳过；目录缺失容错）。 */
  private async prune(): Promise<void> {
    const dir = this.options.dir;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const metas: { id: string; createdAt: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed = parseJsonSafe(await fs.readFile(path.join(dir, entry.name, 'snapshot.json'), 'utf8')) as Snapshot;
        if (typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed.createdAt !== 'string') continue;
        metas.push({ id: parsed.id, createdAt: parsed.createdAt });
      } catch {
        // 损坏 / 非快照目录：跳过（与 listSnapshots 语义一致）
      }
    }
    for (const id of selectPruneCandidates(metas)) {
      const target = path.join(dir, id);
      if (!target.startsWith(dir)) continue; // 越界 id 跳过（不删、不抛，同 save/readBlob 包含性约定）
      await fs.rm(target, { recursive: true, force: true });
    }
  }

  async load(id: string): Promise<Snapshot> {
    const raw = await fs.readFile(path.join(this.snapshotDir(id), 'snapshot.json'), 'utf8');
    return parseJsonSafe(raw) as Snapshot;
  }

  async readBlob(id: string, blobPath: string): Promise<Uint8Array> {
    const target = path.join(this.snapshotDir(id), blobPath);
    const dir = this.options.dir;
    if (!target.startsWith(dir)) throw new Error(`快照 blob 路径越界: ${blobPath}`);
    return fs.readFile(target);
  }

  /** 标记快照生命周期状态：重写 <dir>/<id>/snapshot.json（保留其余字段）。 */
  async updateStatus(id: string, status: SnapshotStatus): Promise<void> {
    const file = path.join(this.snapshotDir(id), 'snapshot.json');
    const snapshot = parseJsonSafe(await fs.readFile(file, 'utf8')) as Snapshot;
    snapshot.status = status;
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2));
  }
}
