/**
 * Configuration Profiles（规范 §20，Phase 6）。
 *
 * Profile = 用户在 DSH 中的一组配置快照（Work / Personal / Development / Minimal），
 * 每个 Profile 含 settings / ui / providers / plugins / mcp / prompts / skills / agentPresets
 * 等所选分区（复用 m5 ConfigAdapter 的导出数据形状）。
 *
 * 存储（v1）：
 *   <dataDir>/profiles/<name>/profile.json
 *   - dataDir 建议 = ~/.dsh/dsh-config-manager（插件自有数据目录，参照 dsh-ssh.json 先例；
 *     由宿主注入绝对路径，本模块用 node:fs 直接操作）
 *   - profile.json = { name, version:1, createdAt, updatedAt, sections }
 *   - 文件类分区（skills/agentPresets/sessions/pluginFiles）的 files[].data 以 base64 内嵌
 *     （Profile 单目录内自包含，便于 Duplicate / Export / Import）
 *
 * 安全不变量（与备份一致）：
 *   - Save 走 adapter.export（describe redactSecrets）→ Profile 天然不含秘密值；
 *   - Switch 不绕过 Preview 与 Snapshot：analyzeSwitch（纯读 Preview）→ confirm → createSnapshot
 *     → 分阶段 applyItem → 失败 rollback（复用 core/backup.ts + core/rollback.ts）；
 *   - Profile 名严格校验（拒绝路径穿越）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { zhMsg } from '../core/messages.ts';
import { ImportNotConfirmedError } from '../core/types.ts';
import { isFileSection } from '../schema/config.ts';
import { stringifyJsonSafe, parseJsonSafe } from '../utils/json.ts';
import type {
  ApplyResult, ConfigAdapter, ExecutedItem, GlobalConflictStrategy, HostContext,
  ImportContext, ImportPlan, ItemResolution, PlanItem, RollbackReport,
  SnapshotStore,
} from '../core/types.ts';
import type { FilesSection, Manifest, SectionId } from '../schema/types.ts';

/* ---------------- 类型 ---------------- */

export interface ProfileMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
  sections: SectionId[];
  fileCount: number;
}

/** profile.json 的磁盘形状（文件类分区 data 为 base64） */
export interface StoredProfile {
  name: string;
  version: 1;
  createdAt: string;
  updatedAt: string;
  sections: Partial<Record<SectionId, unknown>>;
}

export interface SwitchPreview {
  items: PlanItem[];
  missingSecrets: { ref: string; required: boolean }[];
  needsRestart: boolean;
  sectionsInProfile: SectionId[];
}

export interface ProfileSwitchResult {
  ok: boolean;
  executed: ExecutedItem[];
  needsRestart: boolean;
  missingSecrets: string[];
  warnings: string[];
  rollback: RollbackReport | null;
  snapshotId: string | null;
}

export interface ProfileManagerOptions {
  /** Profile 根目录（建议 ~/.dsh/dsh-config-manager，绝对路径） */
  dataDir: string;
  ctx: HostContext;
  adapters: ConfigAdapter[];
  snapshotStore: SnapshotStore;
  /** Save/切换涉及的默认分区（缺省 = adapter.defaultIncluded 的分区） */
  includeSections?: SectionId[];
}

/** 执行阶段顺序（与 core/analyzer.ts APPLY_ORDER 对齐：副作用大的 patch/安装最后） */
export const APPLY_ORDER: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'prompts', 'skills', 'agentPresets',
  'agentInstructions', 'workspaces', 'pluginFiles', 'mcp', 'plugins', 'credentialsStatus',
];

/** Profile 名校验：拒绝路径穿越与非法字符 */
export function isValidProfileName(name: string): boolean {
  if (name === '' || name.length > 64) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.includes('..')) return false;
  return true;
}

/* ---------------- 序列化（文件类分区 base64 内嵌） ---------------- */

interface StoredFileEntry { relativePath: string; data: string; contentHash: string }

/** Profile 落盘编码：文件类分区 files[].data(Uint8Array) → base64；JSON 分区原样（已可序列化） */
export function encodeSections(sections: ReadonlyMap<SectionId, unknown>): Partial<Record<SectionId, unknown>> {
  const out: Partial<Record<SectionId, unknown>> = {};
  for (const [sectionId, data] of sections) {
    if (isFileSection(sectionId)) {
      const files = (data as FilesSection).files ?? [];
      out[sectionId] = {
        version: 1,
        files: files.map((f) => ({
          relativePath: f.relativePath,
          data: Buffer.from(f.data).toString('base64'),
          contentHash: f.contentHash,
        })),
      };
    } else {
      out[sectionId] = data;
    }
  }
  return out;
}

/** Profile 读入解码：base64 → Uint8Array */
export function decodeSections(encoded: Partial<Record<SectionId, unknown>>): Map<SectionId, unknown> {
  const sections = new Map<SectionId, unknown>();
  for (const [sectionId, data] of Object.entries(encoded) as [SectionId, unknown][]) {
    if (isFileSection(sectionId) && data !== null && typeof data === 'object') {
      const files = ((data as { files?: StoredFileEntry[] }).files ?? []).map((f) => ({
        relativePath: f.relativePath,
        data: Uint8Array.from(Buffer.from(f.data, 'base64')),
        contentHash: f.contentHash,
      }));
      sections.set(sectionId, { version: 1, files });
    } else {
      sections.set(sectionId, data);
    }
  }
  return sections;
}

/* ---------------- ProfileManager ---------------- */

export class ProfileManager {
  private readonly dataDir: string;
  private readonly ctx: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly snapshotStore: SnapshotStore;
  private readonly includeSections: SectionId[];
  private readonly profilesDir: string;

  constructor(options: ProfileManagerOptions) {
    this.dataDir = options.dataDir;
    this.ctx = options.ctx;
    this.adapters = options.adapters;
    this.snapshotStore = options.snapshotStore;
    this.includeSections = options.includeSections ??
      this.adapters.filter((a) => a.defaultIncluded).map((a) => a.id);
    this.profilesDir = path.join(this.dataDir, 'profiles');
  }

  /* ---------------- 基础 ---------------- */

  async list(): Promise<ProfileMeta[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.profilesDir, { withFileTypes: true }).then((es) =>
        es.filter((e) => e.isDirectory()).map((e) => e.name).sort());
    } catch {
      return []; // 目录不存在视为空
    }
    const metas: ProfileMeta[] = [];
    for (const name of entries) {
      try {
        metas.push(await this.meta(name));
      } catch {
        // 损坏的 profile 目录跳过（如实不报）
      }
    }
    return metas;
  }

  private profileDir(name: string): string {
    return path.join(this.profilesDir, name);
  }

  private profileFile(name: string): string {
    return path.join(this.profileDir(name), 'profile.json');
  }

  private async meta(name: string): Promise<ProfileMeta> {
    const stored = await this.readStored(name);
    const sections = Object.keys(stored.sections) as SectionId[];
    return {
      name: stored.name,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      sections,
      fileCount: sections.length,
    };
  }

  private async readStored(name: string): Promise<StoredProfile> {
    if (!isValidProfileName(name)) throw new Error(`非法 Profile 名: "${name}"`);
    let raw: string;
    try {
      raw = await fs.readFile(this.profileFile(name), 'utf8');
    } catch (err) {
      throw new Error(`Profile "${name}" 不存在或不可读: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = parseJsonSafe(raw) as StoredProfile;
    if (parsed === null || typeof parsed !== 'object' || parsed.name !== name || parsed.version !== 1) {
      throw new Error(`Profile "${name}" 数据无效（name/version 不匹配）`);
    }
    if (parsed.sections === null || typeof parsed.sections !== 'object') {
      throw new Error(`Profile "${name}" 缺少 sections`);
    }
    return parsed;
  }

  private async writeStored(stored: StoredProfile): Promise<void> {
    await fs.mkdir(this.profileDir(stored.name), { recursive: true });
    await fs.writeFile(this.profileFile(stored.name), stringifyJsonSafe(stored, { space: 2 }), 'utf8');
  }

  /* ---------------- Save / Duplicate / Rename / Delete ---------------- */

  /** 保存当前 DSH 配置为 Profile（复用 adapter.export，天然不含秘密值） */
  async saveCurrent(name: string, opts: { sections?: SectionId[] } = {}): Promise<ProfileMeta> {
    if (!isValidProfileName(name)) throw new Error(`非法 Profile 名: "${name}"`);
    const selected = opts.sections ?? this.includeSections;
    const sections = new Map<SectionId, unknown>();
    for (const adapter of this.adapters) {
      if (!selected.includes(adapter.id)) continue;
      try {
        const section = await adapter.export(this.ctx, { includeSecrets: false, only: [adapter.id] });
        const isEmpty = section.counts && Object.values(section.counts).every((n) => n === 0);
        if (!isEmpty) sections.set(adapter.id, section.data);
      } catch (err) {
        this.ctx.log.warn(`保存 Profile "${name}" 时分区 ${adapter.id} 导出失败，已跳过: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sections.size === 0) {
      throw new Error(`Profile "${name}" 没有任何可保存的配置分区`);
    }
    const now = new Date().toISOString();
    const stored: StoredProfile = {
      name,
      version: 1,
      createdAt: now,
      updatedAt: now,
      sections: encodeSections(sections),
    };
    await this.writeStored(stored);
    return this.meta(name);
  }

  /** 复制 Profile（含全部分区数据） */
  async duplicate(name: string, newName: string): Promise<ProfileMeta> {
    if (!isValidProfileName(newName)) throw new Error(`非法新 Profile 名: "${newName}"`);
    const stored = await this.readStored(name);
    const now = new Date().toISOString();
    const copy: StoredProfile = {
      ...structuredClone(stored),
      name: newName,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeStored(copy);
    return this.meta(newName);
  }

  /** 重命名 Profile（目录级移动） */
  async rename(oldName: string, newName: string): Promise<ProfileMeta> {
    if (!isValidProfileName(newName)) throw new Error(`非法新 Profile 名: "${newName}"`);
    const stored = await this.readStored(oldName); // 存在性检查
    if (oldName === newName) return this.meta(oldName);
    if (await this.exists(newName)) throw new Error(`Profile "${newName}" 已存在`);
    stored.name = newName;
    stored.updatedAt = new Date().toISOString();
    await fs.mkdir(this.profileDir(newName), { recursive: true });
    await fs.writeFile(this.profileFile(newName), stringifyJsonSafe(stored, { space: 2 }), 'utf8');
    await fs.rm(this.profileDir(oldName), { recursive: true, force: true });
    return this.meta(newName);
  }

  /** 删除 Profile */
  async delete(name: string): Promise<void> {
    if (!isValidProfileName(name)) throw new Error(`非法 Profile 名: "${name}"`);
    await this.readStored(name); // 存在性检查
    await fs.rm(this.profileDir(name), { recursive: true, force: true });
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await fs.access(this.profileFile(name));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- Switch（Preview + Snapshot + Rollback 安全流程） ---------------- */

  /** Preview（纯读，零写入）：分析切换到该 Profile 会产生的计划项 */
  async analyzeSwitch(name: string): Promise<SwitchPreview> {
    const stored = await this.readStored(name);
    const sections = decodeSections(stored.sections);
    const { items } = await this.analyzeSections(sections);
    const missingSecrets = items
      .filter((i) => i.kind === 'MissingSecret')
      .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));
    const needsRestart = items.some(
      (i) => i.kind === 'Install' || (i.adapter === 'mcp' && i.kind !== 'Skip' && i.kind !== 'Warning'),
    );
    return {
      items,
      missingSecrets,
      needsRestart,
      sectionsInProfile: [...sections.keys()],
    };
  }

  /** 执行切换：confirm → Snapshot → 分阶段 apply → 失败 rollback（与导入同一安全语义） */
  async executeSwitch(
    name: string,
    opts: {
      confirm?: boolean;
      strategy?: GlobalConflictStrategy;
      resolutions?: Record<string, ItemResolution>;
      secretInputs?: Record<string, string>;
      decryptedCredentials?: Map<string, string>;
      rollbackOnError?: boolean;
    } = {},
  ): Promise<ProfileSwitchResult> {
    // 安全阀：不确认绝不动数据（对齐 ImportNotConfirmedError）
    if (opts.confirm !== true) throw new ImportNotConfirmedError();

    const stored = await this.readStored(name);
    const sections = decodeSections(stored.sections);
    const { items: rawItems } = await this.analyzeSections(sections);
    const strategy = opts.strategy ?? 'merge';
    const items = rawItems.map((item) => applyResolution(item, strategy, opts.resolutions ?? {}));

    const missingSecrets = items
      .filter((i) => i.kind === 'MissingSecret')
      .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));
    const needsRestart = items.some(
      (i) => i.kind === 'Install' || (i.adapter === 'mcp' && i.kind !== 'Skip' && i.kind !== 'Warning'),
    );

    const plan: ImportPlan = {
      items,
      globalStrategy: strategy,
      pathMappings: [],
      missingSecrets,
      needsRestart,
      estimatedActions: {} as ImportPlan['estimatedActions'],
    };

    // Snapshot（强制：切换前备份将被修改的目标，复用 core/backup.ts）
    const snapshot = await createSnapshot({
      ctx: this.ctx,
      plan,
      sourceZip: `profile:${name}`,
      store: this.snapshotStore,
      adapters: this.adapters,
    });

    const importCtx: ImportContext = {
      manifest: buildProfileManifest(this.ctx),
      targetPlatform: this.ctx.platform,
      target: this.ctx,
      sections,
      pathMappings: [],
      resolutions: opts.resolutions ?? {},
      secretInputs: opts.secretInputs ?? {},
      decryptedCredentials: opts.decryptedCredentials,
      log: this.ctx.log,
      msg: this.ctx.msg ?? zhMsg,
    };

    const executed: ExecutedItem[] = [];
    const warnings: string[] = [];
    let anyFailed = false;
    let finalNeedsRestart = needsRestart;

    const byAdapter = new Map<SectionId, PlanItem[]>();
    for (const item of items) {
      const list = byAdapter.get(item.adapter) ?? [];
      list.push(item);
      byAdapter.set(item.adapter, list);
    }

    for (const adapterId of APPLY_ORDER) {
      const adapter = this.adapters.find((a) => a.id === adapterId);
      if (!adapter) continue;
      for (const item of byAdapter.get(adapterId) ?? []) {
        const outcome = await this.applyOne(adapter, item, importCtx);
        executed.push(outcome.executed);
        if (outcome.executed.status === 'failed') anyFailed = true;
        if (outcome.needsRestart) finalNeedsRestart = true;
        if (outcome.warning) warnings.push(outcome.warning);
        if (opts.rollbackOnError && outcome.executed.status === 'failed') break;
      }
      if (opts.rollbackOnError && anyFailed) break;
    }

    // 失败整体回滚（复用 core/rollback.ts，逆序补偿 + 诚实报告）
    if (opts.rollbackOnError && anyFailed) {
      const rollbackReport = await rollback({
        ctx: this.ctx,
        snapshot,
        store: this.snapshotStore,
        adapters: this.adapters,
      });
      this.ctx.log.warn(`Profile "${name}" 切换失败，已回滚（${rollbackReport.full ? '完整' : '部分'}）`, {
        failed: executed.filter((e) => e.status === 'failed').map((e) => e.itemId),
      });
      return {
        ok: false,
        executed,
        needsRestart: false,
        missingSecrets: [],
        warnings,
        rollback: rollbackReport,
        snapshotId: snapshot.id,
      };
    }

    const remainingSecrets = missingSecrets
      .filter((s) => !importCtx.decryptedCredentials?.has(s.ref) && !importCtx.secretInputs[s.ref])
      .map((s) => s.ref);

    return {
      ok: true,
      executed,
      needsRestart: finalNeedsRestart,
      missingSecrets: remainingSecrets,
      warnings,
      rollback: null,
      snapshotId: snapshot.id,
    };
  }

  /** 逐分区 validate + analyzeImport（纯计算；MissingSecret 兜底与 analyzer.ensureMissingSecrets 等价） */
  private async analyzeSections(
    sections: Map<SectionId, unknown>,
  ): Promise<{ items: PlanItem[]; issues: string[] }> {
    const importCtx: ImportContext = {
      manifest: buildProfileManifest(this.ctx),
      targetPlatform: this.ctx.platform,
      target: this.ctx,
      sections,
      pathMappings: [],
      resolutions: {},
      secretInputs: {},
      log: this.ctx.log,
      msg: this.ctx.msg ?? zhMsg,
    };
    const items: PlanItem[] = [];
    const issues: string[] = [];
    for (const adapter of this.adapters) {
      const data = sections.get(adapter.id);
      if (data === undefined) continue;
      try {
        const v = await adapter.validate(data);
        for (const issue of v.issues) {
          if (issue.severity === 'error') issues.push(`${adapter.id}: ${issue.message}`);
        }
        if (!v.valid) continue;
        items.push(...await adapter.analyzeImport(data, importCtx));
      } catch (err) {
        issues.push(`${adapter.id}: 分析失败 ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // MissingSecret 兜底：credentialsStatus 分区里已配置凭据若没有对应计划项，补占位
    const creds = sections.get('credentialsStatus') as { credentials?: { ref?: string; configured?: boolean }[] } | undefined;
    if (creds?.credentials) {
      const existing = new Set(items.filter((i) => i.kind === 'MissingSecret').map((i) => i.id));
      for (const c of creds.credentials) {
        if (!c.ref || c.configured !== true) continue;
        const id = `secret:${c.ref}`;
        if (existing.has(id)) continue;
        items.push({
          id, kind: 'MissingSecret', adapter: 'credentialsStatus',
          description: `凭据 ${c.ref} 需要补录`, severity: 'warning',
          target: { adapter: 'credentialsStatus', ref: c.ref },
        });
        existing.add(id);
      }
    }
    return { items, issues };
  }

  /** 单计划项执行（语义对齐 core/analyzer.ts applyOne） */
  private async applyOne(
    adapter: ConfigAdapter,
    item: PlanItem,
    ctx: ImportContext,
  ): Promise<{ executed: ExecutedItem; needsRestart: boolean; warning?: string }> {
    if (item.kind === 'Skip' || (item.kind === 'Conflict' && item.conflict?.resolution !== 'useImported')) {
      return { executed: { itemId: item.id, status: 'skipped' }, needsRestart: false };
    }
    if (item.kind === 'Error') {
      return { executed: { itemId: item.id, status: 'failed', message: item.detail ?? item.description }, needsRestart: false };
    }
    if (item.kind === 'MissingSecret') {
      const ref = item.id.replace(/^secret:/, '');
      const value = ctx.decryptedCredentials?.get(ref) ?? ctx.secretInputs[ref];
      if (value === undefined || value === '') {
        return { executed: { itemId: item.id, status: 'skipped', message: '凭据未提供，需补录' }, needsRestart: false };
      }
    }
    try {
      const result: ApplyResult = await adapter.applyItem(item, ctx);
      const status = result.ok ? 'ok' : (result.warning === true ? 'warning' : 'failed');
      return {
        executed: { itemId: item.id, status, message: result.message },
        needsRestart: result.needsRestart === true,
        warning: result.warning === true ? `${item.id}: ${result.message ?? item.description}` : undefined,
      };
    } catch (err) {
      this.ctx.log.error(`切换 Profile 应用计划项失败 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      return {
        executed: { itemId: item.id, status: 'failed', message: err instanceof Error ? err.message : String(err) },
        needsRestart: false,
      };
    }
  }

  /* ---------------- Export / Import Profile ---------------- */

  /** 导出 Profile 为单 JSON 文件（dsh-profile-<name>.json，自包含可分发；文件类数据 base64 内嵌） */
  async exportProfile(name: string, outPath: string): Promise<{ path: string; fileCount: number }> {
    const stored = await this.readStored(name);
    await fs.writeFile(outPath, stringifyJsonSafe(stored, { space: 2 }), 'utf8');
    return { path: outPath, fileCount: Object.keys(stored.sections).length };
  }

  /** 导入 Profile 文件（JSON 校验 + 存入 profiles 目录；同名已存在默认拒绝） */
  async importProfile(filePath: string, opts: { asName?: string } = {}): Promise<ProfileMeta> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Profile 文件不可读: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = parseJsonSafe(raw) as StoredProfile;
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 || parsed.sections === null) {
      throw new Error('Profile 文件无效（缺少 version/sections）');
    }
    const name = opts.asName ?? parsed.name;
    if (!isValidProfileName(name)) throw new Error(`非法 Profile 名: "${name}"`);
    if (await this.exists(name)) throw new Error(`Profile "${name}" 已存在，请先删除或指定 asName`);
    const now = new Date().toISOString();
    const stored: StoredProfile = {
      name,
      version: 1,
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
      sections: parsed.sections,
    };
    await this.writeStored(stored);
    return this.meta(name);
  }
}

/* ---------------- 纯函数辅助 ---------------- */

/** 应用用户冲突决策 + 全局策略（对齐 core/analyzer.ts applyItemResolution） */
function applyResolution(
  item: PlanItem,
  strategy: GlobalConflictStrategy,
  resolutions: Record<string, ItemResolution>,
): PlanItem {
  if (item.kind !== 'Conflict') return item;
  const resolution = resolutions[item.id];
  if (resolution === 'keepCurrent') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}（用户选择保留当前）` };
  }
  if (resolution === 'useImported') {
    return { ...item, kind: 'Update', severity: 'info', conflict: { itemId: item.id, resolution } };
  }
  if (strategy === 'skipExisting') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}（skipExisting 策略）` };
  }
  if (strategy === 'replace') {
    return { ...item, kind: 'Update', severity: 'info', detail: `${item.detail ?? ''}（replace 策略）` };
  }
  return item; // merge + 未决策 → 保持 Conflict（执行时跳过，报告列明）
}

/** 构造切换用的最小 manifest（Profile 非 ZIP 备份，sourceZip 语义用 profile:<name>） */
function buildProfileManifest(ctx: HostContext): Manifest {
  return {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: '0.1.0' },
    source: {
      dshVersion: ctx.dshVersion,
      platform: ctx.platform as Manifest['source']['platform'],
      arch: ctx.arch,
    },
    exportedAt: new Date().toISOString(),
    sections: {
      settings: false, ui: false, providers: false, plugins: false, mcp: false, prompts: false,
      skills: false, agentPresets: false, agentInstructions: false, workspaces: false, pluginFiles: false,
      credentialsStatus: false, secrets: false, sessions: false, self: false,
    },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
}
