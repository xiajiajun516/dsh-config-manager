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
  ConfigAdapter, HostContext, ImportPlan, PlanItem, Snapshot,
  SnapshotEntry, SnapshotStore, SnapshotTarget,
} from './types.ts';

/** 导入将实际写入的目标 kinds（这些项才需要快照） */
const EXECUTABLE_KINDS = new Set(['Create', 'Update', 'Install', 'MissingSecret', 'MissingDependency']);

/** 文件类分区的目标基准目录（相对 homeDir；pluginFiles 的 ref 已是完整相对路径） */
const FILE_BASES: Partial<Record<SectionId, string>> = {
  skills: 'skills',
  agentPresets: '.agent-presets',
  pluginFiles: '',
  sessions: 'sessions',
};

/** 解析文件类目标的绝对路径（引擎通用快照与回滚共用） */
export function resolveFileTarget(ctx: HostContext, adapter: SectionId, ref: string): string {
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

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip,
    entries,
  };
  // file 条目登记 snapshotId，回滚读 blob 时定位快照目录
  for (const entry of snapshot.entries) {
    if (entry.kind === 'file') entry.snapshotId = snapshot.id;
  }
  await store.save(snapshot, blobs);
  return snapshot;
}

/* ---------------- 默认文件快照存储 ---------------- */

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
    return snapshot.id;
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
}
