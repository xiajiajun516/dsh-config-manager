/**
 * 适配器测试基础设施（仿 src/core/smoke.test.ts 的内存 mock 门面）。
 * 仅供 src/adapters/*.test.ts 使用，不参与生产构建语义。
 */
import { normalizePath } from '../utils/paths.ts';
import { createLogger, type Logger } from '../utils/logger.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { zhMsg } from '../core/messages.ts';
import { USER_PATCH_FILE } from '../core/patch-layers.ts';
import type {
  CredentialsFacade, FileSystemFacade, HostContext, ImportContext, NamespaceInfo,
  PatchFileFacade, PluginInfo, PluginsFacade, SettingsFacade, Snapshot,
  SnapshotStore, WorkspaceFacade,
} from '../core/types.ts';
import type { Manifest, SectionId, WorkspaceRecord } from '../schema/types.ts';

export class MemFs implements FileSystemFacade {
  files = new Map<string, Uint8Array>();
  /** 可选（issue #37）：详细的链接遍历。测试按需注入；缺省走 listRecursive 回退路径。 */
  listRecursiveDetailed?: FileSystemFacade['listRecursiveDetailed'];
  /** 可选（issue #45）：建缺失目录能力。测试按需注入；缺省维持「宿主不支持该能力」的旧行为。 */
  ensureDir?: FileSystemFacade['ensureDir'];
  /** 可选（issue #45）：绝对路径 realpath。测试按需注入；缺省维持「宿主不支持」的旧行为。 */
  realpathDir?: FileSystemFacade['realpathDir'];
  /** 可选（只读预览）：目录体积上界。测试按需注入；缺省维持「宿主不支持」的旧行为（`link:` 体积按 0）。 */
  dirSizeBytes?: FileSystemFacade['dirSizeBytes'];
  private readonly homeDir: string;
  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }
  private key(p: string): string {
    return normalizePath(p.startsWith(this.homeDir) ? p : `${this.homeDir}/${p}`);
  }
  async readFile(relPath: string): Promise<Uint8Array> {
    const v = this.files.get(this.key(relPath));
    if (v === undefined) throw new Error(`ENOENT: ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    this.files.set(this.key(relPath), data);
  }
  async exists(relPath: string): Promise<boolean> {
    return this.files.has(this.key(relPath));
  }
  async copy(from: string, to: string): Promise<void> {
    const v = this.files.get(this.key(from));
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(this.key(to), v);
  }
  async remove(relPath: string): Promise<void> {
    this.files.delete(this.key(relPath));
  }
  /**
   * 测试用 mtime 表（key 与 files 同一规则）。**未登记的文件返回 null**，
   * 与真实门面「读不到时间」同语义 —— 让「把未知当最旧」这类缺陷在测试里必然暴露。
   */
  mtimes = new Map<string, number>();
  /** 测试助手：登记某文件的 mtime（null = 恢复为「读不到」） */
  setMtime(relPath: string, ms: number | null): void {
    if (ms === null) this.mtimes.delete(this.key(relPath));
    else this.mtimes.set(this.key(relPath), ms);
  }
  async mtimeMs(relPath: string): Promise<number | null> {
    return this.mtimes.get(this.key(relPath)) ?? null;
  }
  /**
   * 文件字节数（只读预览用）。
   *
   * 语义与真实门面一致：**读不到 → null**（不返回 0）—— 0 会让字节闸门少算，
   * 让预览把本该剔除的单元也列出来，与真实导出分叉。
   */
  async statSize(relPath: string): Promise<number | null> {
    const v = this.files.get(this.key(relPath));
    return v === undefined ? null : v.byteLength;
  }
  async listRecursive(dir: string): Promise<string[]> {
    const base = normalizePath(this.homeDir);
    const prefix = normalizePath(dir) === '' ? base : `${base}/${normalizePath(dir)}`;
    const out: string[] = [];
    for (const k of this.files.keys()) {
      if (k === prefix || k.startsWith(prefix + '/')) {
        out.push(k.slice(base.length).replace(/^[\\/]+/, ''));
      }
    }
    return out.sort();
  }
  async mkdir(): Promise<void> { /* 内存实现无需建目录 */ }
}

/** ns.set 时自动注册（有值即视为对应插件已激活；对齐真实 dsh-settings 的注册语义） */
class AutoRegisterMap extends Map<string, { value: unknown; base?: unknown; revision: number; applies?: string[]; secrets: { path: string[]; set: boolean }[] }> {
  private readonly registered: Set<string>;
  constructor(registered: Set<string>) {
    super();
    this.registered = registered;
  }
  override set(key: string, value: { value: unknown; base?: unknown; revision: number; applies?: string[]; secrets: { path: string[]; set: boolean }[] }): this {
    this.registered.add(key);
    return super.set(key, value);
  }
}

export class MemSettings implements SettingsFacade {
  /** 已注册命名空间（对齐真实 dsh-settings：插件激活时注册；未注册的 describe/replace 抛错） */
  registered = new Set<string>();
  /**
   * 可选（宿主能力探测）：**默认不提供** ⇒ 既有测试继续覆盖「逐名 describe」回退路径；
   * 需要验证快路径的测试自行挂上（真实宿主 DshSettingsFacade 始终提供）。
   */
  describeAll?: SettingsFacade['describeAll'];
  /** 有值的命名空间自动视为已注册 */
  ns = new AutoRegisterMap(this.registered);
  async describe(namespace: string, _opts?: { redactSecrets?: boolean }): Promise<NamespaceInfo> {
    if (!this.registered.has(namespace)) throw new Error(`settings namespace "${namespace}" is not registered`);
    const rec = this.ns.get(namespace);
    return {
      value: rec?.value,
      base: rec?.base,
      revision: rec?.revision ?? 0,
      applies: rec?.applies,
      secrets: rec?.secrets ?? [],
    };
  }
  async replace(namespace: string, value: unknown, expectedRevision?: number): Promise<void> {
    if (!this.registered.has(namespace)) throw new Error(`settings namespace "${namespace}" is not registered`);
    const rec = this.ns.get(namespace);
    if (expectedRevision !== undefined && rec && rec.revision !== expectedRevision) {
      throw new Error(`SETTINGS_CONFLICT: ${namespace} revision ${rec.revision} !== ${expectedRevision}`);
    }
    this.ns.set(namespace, {
      value, revision: (rec?.revision ?? 0) + 1, secrets: rec?.secrets ?? [], base: rec?.base, applies: rec?.applies,
    });
  }
  async update?(namespace: string, patch: unknown, expectedRevision?: number): Promise<void> {
    if (!this.registered.has(namespace)) throw new Error(`settings namespace "${namespace}" is not registered`);
    const rec = this.ns.get(namespace);
    if (expectedRevision !== undefined && rec && rec.revision !== expectedRevision) {
      throw new Error(`SETTINGS_CONFLICT: ${namespace} revision ${rec.revision} !== ${expectedRevision}`);
    }
    const merged = { ...(rec?.value as Record<string, unknown> | undefined), ...(patch as Record<string, unknown>) };
    this.ns.set(namespace, { value: merged, revision: (rec?.revision ?? 0) + 1, secrets: rec?.secrets ?? [] });
  }
}

export class MemCredentials implements CredentialsFacade {
  values = new Map<string, string>();
  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }> {
    const v = this.values.get(ref);
    return { configured: v !== undefined, source: v !== undefined ? 'file' : 'env', writable: true };
  }
  async set(ref: string, value: string): Promise<void> { this.values.set(ref, value); }
  async unset(ref: string): Promise<void> { this.values.delete(ref); }
}

export class MemPlugins implements PluginsFacade {
  installed = new Map<string, PluginInfo>();
  /** 测试钩子：install 抛错（模拟 npm ERESOLVE / 网络失败） */
  failInstall = false;
  /** 测试钩子：记录最近一次 install 收到的 spec（验证非 registry spec 透传） */
  lastSpec: string | undefined;
  async listInstalled(): Promise<PluginInfo[]> {
    return [...this.installed.values()];
  }
  async install(pkg: string, spec?: string): Promise<{ needsRestart: boolean }> {
    if (this.failInstall) throw new Error(`npm error code ERESOLVE: could not resolve ${pkg}`);
    if (this.installed.has(pkg)) return { needsRestart: false };
    this.lastSpec = spec;
    this.installed.set(pkg, { name: pkg, version: '1.0.0', enabled: true, spec });
    return { needsRestart: true };
  }
}

export class MemWorkspace implements WorkspaceFacade {
  records = new Map<string, WorkspaceRecord>();
  /** 可选（issue #45）：测试按需注入的会话登记钩子；缺省维持「宿主不支持该能力」的旧行为。 */
  attachSession?: WorkspaceFacade['attachSession'];
  async listRecords(): Promise<WorkspaceRecord[]> { return [...this.records.values()]; }
  async writeRecord(r: WorkspaceRecord): Promise<void> { this.records.set(r.id, r); }
  async removeRecord(id: string): Promise<void> { this.records.delete(id); }
}

/**
 * 内存 patch 门面，**按层分桶**（issue #71）。
 *
 * `lines` 仍是**用户（home）层**的桶 —— 绝大多数既有测试只关心「一行进、一行出」，
 * 直接操作 `lines` 即可，语义与改造前完全一致。其它层（profile 层）走 `byFile`：
 * 缺省空桶，因此「读两层」的调用方在旧测试里读到的 profile 层就是空的，不会污染断言。
 *
 * 分层用 `byFile(rel)` 显式取桶，避免测试里手写路径字符串。
 */
export class MemPatch implements PatchFileFacade {
  /** 用户（home）层桶：`cordis.patch.yml`。 */
  lines = new Map<string, { lineId: string; raw: unknown }>();
  /** 其它层桶：层路径 → 行表（profile 层等）。 */
  byFile = new Map<string, Map<string, { lineId: string; raw: unknown }>>();

  /** 取（必要时建）某一层的桶；用户层恒为 `lines`（与旧测试兼容）。 */
  bucket(file: string): Map<string, { lineId: string; raw: unknown }> {
    if (file === USER_PATCH_FILE) return this.lines;
    let bucket = this.byFile.get(file);
    if (bucket === undefined) {
      bucket = new Map<string, { lineId: string; raw: unknown }>();
      this.byFile.set(file, bucket);
    }
    return bucket;
  }

  async readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]> {
    if (file === USER_PATCH_FILE) return [...this.lines.values()];
    const bucket = this.byFile.get(file);
    return bucket === undefined ? [] : [...bucket.values()];
  }

  async applyPatchChanges(
    file: string,
    changes: { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove' }[],
  ): Promise<void> {
    const bucket = this.bucket(file);
    for (const c of changes) {
      if (c.action === 'remove') bucket.delete(c.lineId);
      else bucket.set(c.lineId, { lineId: c.lineId, raw: c.raw });
    }
  }
}

export class MemSnapshotStore implements SnapshotStore {
  snapshots = new Map<string, Snapshot>();
  blobs = new Map<string, Uint8Array>();
  async save(snapshot: Snapshot, blobs: Map<string, Uint8Array> = new Map()): Promise<string> {
    this.snapshots.set(snapshot.id, snapshot);
    for (const [k, v] of blobs) this.blobs.set(`${snapshot.id}/${k}`, v);
    return snapshot.id;
  }
  async load(id: string): Promise<Snapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`snapshot not found: ${id}`);
    return s;
  }
  async readBlob(id: string, blobPath: string): Promise<Uint8Array> {
    const v = this.blobs.get(`${id}/${blobPath}`);
    if (!v) throw new Error(`blob not found: ${id}/${blobPath}`);
    return v;
  }
  async updateStatus(id: string, status: Snapshot['status']): Promise<void> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`snapshot not found: ${id}`);
    s.status = status;
  }
}

export class MockHostContext implements HostContext {
  platform: string;
  arch = 'x64';
  homeDir: string;
  dshVersion = '0.1.0-rc.6';
  log: Logger;
  profile?: string;
  settings = new MemSettings();
  credentials = new MemCredentials();
  plugins = new MemPlugins();
  workspace = new MemWorkspace();
  patchFile = new MemPatch();
  fs: MemFs;
  /** 可选（issue #45）：会话存储端口；测试按需注入（缺省 = 宿主未提供该能力）。 */
  sessions?: HostContext['sessions'];
  /** 可选（issue #71）：技能服务端口；测试按需注入（缺省 = 退回纯目录扫描）。 */
  skills?: HostContext['skills'];
  /**
   * 可选（第三方插件数据）：系统 home 与它的文件门面。缺省 undefined = **旧宿主形态**
   * （pluginData / pluginAssets 不收集也不写入，如实报码）；需要它们的测试自行注入，
   * 或用 withOsHome() 把系统 home 指向本夹具自己的根。
   */
  osHomeDir?: string;
  homeFs?: HostContext['homeFs'];

  /** 测试助手：把「系统 home」指向本上下文的根（两分区在本夹具里即可直接用） */
  withOsHome(): this {
    this.osHomeDir = this.homeDir;
    this.homeFs = this.fs;
    return this;
  }
  constructor(platform: string, homeDir: string, profile?: string) {
    this.platform = platform;
    this.homeDir = homeDir;
    this.profile = profile;
    this.fs = new MemFs(homeDir);
    this.log = createLogger({ level: 'error', sink: () => {} });
  }
}

export function makeContext(platform: string, homeDir: string, profile?: string): MockHostContext {
  return new MockHostContext(platform, homeDir, profile);
}

/** 构造最小合法 manifest（adapter 单测用；真实 manifest 由 exporter 生成） */
export function makeManifest(platform = 'win32'): Manifest {
  return {
    schemaVersion: 1,
    exporter: { name: 'dsh-config-manager-test', version: '0.0.0' },
    source: { dshVersion: '0.1.0-rc.6', platform: platform as Manifest['source']['platform'], arch: 'x64' },
    exportedAt: new Date('2026-08-14T12:00:00.000Z').toISOString(),
    sections: {
      settings: false, ui: false, providers: false, plugins: false, mcp: false, prompts: false,
      skills: false, agentPresets: false, agentInstructions: false, workspaces: false, pluginFiles: false,
      credentialsStatus: false, secrets: false, sessions: false, self: false,
      pluginData: false, pluginAssets: false,
    },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
}

/** 构造 ImportContext（adapter 单测用；sections 键运行时即 SectionId 字符串） */
export function makeImportContext(
  target: HostContext,
  sections: ReadonlyMap<string, unknown>,
  overrides: Partial<ImportContext> = {},
): ImportContext {
  return {
    manifest: makeManifest(target.platform),
    targetPlatform: target.platform,
    target,
    sections: sections as Map<SectionId, unknown>,
    pathMappings: [],
    resolutions: {},
    secretInputs: {},
    log: target.log,
    msg: zhMsg,
    ...overrides,
  };
}

export { sha256Hex };
