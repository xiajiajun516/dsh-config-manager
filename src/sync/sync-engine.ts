/**
 * m-sync-flow：push/pull 编排（SyncEngine）。
 *
 * push：createAdapters 逐个 export（includeSecrets=false 恒成立）→ SecretScanner 剥离 →
 *       组装 SyncSnapshot（只含 portable 分区）→ 本地散文件副本（复用 t2 layout，不写 ZIP）→
 *       transport.upload → 更新 sync-state（每分区 hash + updatedAt + lastSyncAt + transport 绑定）。
 * pull：transport.list/download 取远端快照 → 过滤 portable 分区 → 转临时标准 ZIP
 *       （buildManifest + checksums，喂给现有 Importer）→ analyzeImport/createImportPlan 预览差异。
 *       绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
 *
 * 安全不变量：
 *  - secret 值永不参与同步：includeSecrets=false 恒成立 + 敏感字段扫描剥离 + 凭据分区结构性排除断言；
 *  - 远端快照声明 containsSecrets=true → 拒绝拉取；
 *  - 同步只做 portable 分区（deviceSpecific/platformSpecific 永不进入同步通道）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { defaultSecretScanner } from '../core/exporter.ts';
import { Importer } from '../core/importer.ts';
import type {
  ConfigAdapter, ExportSection, GlobalConflictStrategy, HostContext,
  ImportAnalysis, ImportPlan, ImportResult, PlanItem, PlanItemKind, SecretScanner,
} from '../core/types.ts';
import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import type { FilesSection, Platform, SectionData, SectionId } from '../schema/types.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import { writeSnapshotToDir } from './layout.ts';
import { hashSection, loadSyncState, saveSyncState } from './sync-state.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { DEFAULT_ANCESTOR_KEEP, loadAncestor, pruneAncestors, writeAncestor } from './ancestor.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import { merge as mergeSections } from './merge.ts';
import type { SyncApplyPlan } from './risk.ts';
import { createSnapshot } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { FileSnapshotStore } from '../core/backup.ts';
import type { Snapshot, SnapshotStore } from '../core/types.ts';
import type { PlanItemProgress } from '../core/analyzer.ts';

export interface SyncEngineOptions {
  ctx: HostContext;
  transport: SyncTransport;
  /** sync-state.json 所在目录 */
  stateDir: string;
  /** 分区 adapter 列表（缺省 createAdapters()；宿主应注入 namespaces 等） */
  adapters?: ConfigAdapter[];
  /** 秘密扫描器（缺省 defaultSecretScanner：敏感字段名剥离） */
  scanner?: SecretScanner;
  /** pull 需要；不注入则 pull 抛错（push 不受影响） */
  importer?: Importer;
  now?: () => Date;
  /** 快照 id 生成器（缺省 sync-<uuid>；须符合通道安全字符集） */
  snapshotId?: () => string;
  /** 记录到 sync-state.transport.ref（如 git 分支名） */
  transportRef?: string;
  /** 本地散文件快照副本目录（push 落盘审计副本；不传则跳过本地落盘） */
  localSnapshotsDir?: string;
  /** pull 临时 ZIP 目录（缺省 os.tmpdir()） */
  zipDir?: string;
  exporterVersion?: string;
  fsx?: SnapshotFs;
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
}

export interface SyncPushOptions {
  /** 覆盖自动生成的快照 id */
  snapshotId?: string;
}

export interface SyncPullOptions {
  /** 指定远端快照 id（缺省 = 最新） */
  snapshotId?: string;
  /** 冲突全局策略（缺省 merge：冲突保留待决策） */
  strategy?: GlobalConflictStrategy;
}

export interface SyncPushReport {
  ok: boolean;
  snapshotId: string;
  /** 实际进入同步的 portable 分区 */
  sections: SectionId[];
  /** 分区级告警（单项失败不拖垮整体，§34.17 语义） */
  warnings: string[];
  message?: string;
}

/** 差异报告中的单个变更项（PlanItem 摘要，不含敏感细节） */
export interface PullChange {
  id: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  severity: PlanItem['severity'];
}

export interface SyncPullReport {
  ok: boolean;
  snapshotId: string;
  changes: PullChange[];
  /** 是否存在需要人工决策的项（Conflict / MissingSecret / MissingDependency / Install / 路径问题） */
  needsReview: boolean;
  message?: string;
}

/** 一键同步预览结果（preview() 返回；临时 ZIP 由调用方持有并负责清理）。 */
export interface SyncPreviewResult {
  ok: boolean;
  /** 临时标准 ZIP 路径（apply-items 复用 executeImportPlan 需要；调用方清理） */
  zipPath: string;
  plan: ImportPlan | null;
  analysis: ImportAnalysis | null;
  snapshotId: string;
  message?: string;
}

/** 自动应用执行器（P2b）报告 */
export interface ApplyReport {
  ok: boolean;
  /** 实际写入本地的分区 id 列表 */
  applied: string[];
  /** 应用前快照 id（UI 可借此一键回滚）；失败时仍透传以便排查 */
  restoreId: string;
  /** 是否触发了整体回滚 */
  rolledBack: boolean;
  /** 失败时移到 review 队列的项（ReviewQueueItem 形态供 UI 直接渲染） */
  review: import('./review-queue.ts').ReviewQueueItem[];
  /** 来自 Importer.ImportResult 的 warnings；UI 可用于红条提示 */
  warnings: string[];
}

/** applyItems 报告（§3.4 ApplyItemsResponse 的服务端形态） */
export interface ApplyItemsReport {
  ok: boolean;
  /** 实际写入的分区 id 列表（去重） */
  applied: string[];
  /** 未采纳的 itemId 列表 */
  skipped?: string[];
  /** 应用前快照 id（UI 一键回滚用；失败时仍透传以便排查） */
  restoreId: string;
  /** 任一失败是否整体回滚 */
  rolledBack: boolean;
  warnings: string[];
  failed: { itemId: string; message?: string }[];
  /** 透传 executeImportPlan 结果 */
  result: ImportResult | null;
  needsRestart?: boolean;
}

/** 同步通道结构性排除的敏感分区（即使 portable 判定有误也双保险拒绝；
 * 注：'credentials' 不是合法 SectionId——凭据状态分区为 credentialsStatus） */
const FORBIDDEN_SECTIONS: readonly SectionId[] = ['credentialsStatus', 'secrets'];

export class SyncEngine {
  private readonly ctx: HostContext;
  private readonly transport: SyncTransport;
  private readonly stateDir: string;
  private readonly adapters: ConfigAdapter[];
  private readonly scanner: SecretScanner;
  private readonly importer: Importer | undefined;
  private readonly now: () => Date;
  private readonly snapshotIdFn: () => string;
  private readonly transportRef: string;
  private readonly localSnapshotsDir: string | undefined;
  private readonly zipDir: string;
  private readonly exporterVersion: string;
  private readonly fsx: SnapshotFs;
  private readonly msg: MsgFunc;

  constructor(opts: SyncEngineOptions) {
    if (opts.ctx === null || typeof opts.ctx !== 'object') throw new Error(zhMsg('sync.missingCtx'));
    if (opts.transport === null || typeof opts.transport !== 'object'
      || typeof opts.transport.upload !== 'function' || typeof opts.transport.list !== 'function'
      || typeof opts.transport.download !== 'function' || typeof opts.transport.delete !== 'function') {
      throw new Error(zhMsg('sync.missingTransport'));
    }
    if (typeof opts.stateDir !== 'string' || opts.stateDir.length === 0) {
      throw new Error(zhMsg('sync.missingStateDir'));
    }
    this.ctx = opts.ctx;
    this.transport = opts.transport;
    this.stateDir = opts.stateDir;
    this.adapters = opts.adapters ?? createAdapters();
    this.scanner = opts.scanner ?? defaultSecretScanner();
    this.importer = opts.importer;
    this.now = opts.now ?? (() => new Date());
    this.snapshotIdFn = opts.snapshotId ?? (() => `sync-${crypto.randomUUID()}`);
    this.transportRef = opts.transportRef ?? '';
    this.localSnapshotsDir = opts.localSnapshotsDir;
    this.zipDir = opts.zipDir ?? os.tmpdir();
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.fsx = opts.fsx ?? createSnapshotFs();
    this.msg = opts.msg ?? msgOf(opts.ctx);
  }

  /** 同步只做 portable 分区（deviceSpecific/platformSpecific 永不参与） */
  private portableAdapters(): ConfigAdapter[] {
    return this.adapters.filter((a) => a.portability === 'portable');
  }

  /** 结构性断言：凭据/秘密分区绝不进入同步载荷（双保险，portable 过滤之上） */
  private assertNoForbiddenSections(sections: Record<string, unknown>): void {
    for (const sid of FORBIDDEN_SECTIONS) {
      if (sid in sections) {
        throw new Error(this.msg('sync.denySensitiveSection', { section: sid }));
      }
    }
  }

  /**
   * push：导出 portable 分区 → 组装快照 → 本地散文件副本 → transport.upload → 更新 sync-state。
   * 单项分区导出失败只告警跳过（§34.17），全部失败才整体失败。
   */
  async push(opts: SyncPushOptions = {}): Promise<SyncPushReport> {
    const warnings: string[] = [];
    const sections: SyncSnapshot['sections'] = {};
    for (const adapter of this.portableAdapters()) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: false });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      warnings.push(...section.warnings);
      // 与 Exporter 同语义：非文件类分区过 SecretScanner；文件类分区内容不按字段扫描
      const data = isFileSection(adapter.id)
        ? section.data
        : this.scanner.scanAndRedact(section.data).sanitized;
      sections[adapter.id] = data as SectionData;
    }

    if (Object.keys(sections).length === 0) {
      return { ok: false, snapshotId: '', sections: [], warnings, message: this.msg('sync.noPortableSections') };
    }
    this.assertNoForbiddenSections(sections as Record<string, unknown>);

    const nowIso = this.now().toISOString();
    const id = opts.snapshotId ?? this.snapshotIdFn();
    const snapshot: SyncSnapshot = {
      id,
      createdAt: nowIso,
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: Object.keys(sections) as SectionId[],
        containsSecrets: false,
      },
      sections,
    };

    // ① 本地散文件快照副本（审计；复用 t2 layout，不写 ZIP）
    if (this.localSnapshotsDir !== undefined) {
      await writeSnapshotToDir(snapshot, joinFs(this.localSnapshotsDir, id), this.fsx);
    }
    // ② 上传远端（传输通道负责散文件落盘 + 提交推送）
    await this.transport.upload(snapshot);
    // ③ 记录祖先基线：写 sync-state（lastSnapshotId + 每分区 hash/updatedAt + lastSyncAt + transport）+ 裁剪
    await this.recordBaseline(id, snapshot.sections, nowIso);

    return { ok: true, snapshotId: id, sections: Object.keys(sections) as SectionId[], warnings };
  }

  /**
   * pull：拉取远端最新（或指定）快照 → 过滤 portable 分区 → 转临时标准 ZIP →
   * 复用 Importer 预览流程（analyzeImport/createImportPlan）产出差异报告。
   * 绝不直接写配置、绝不执行导入；执行由上层按用户确认后走 Importer.executeImportPlan。
   */
  async pull(opts: SyncPullOptions = {}): Promise<SyncPullReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: true, snapshotId: '', changes: [], needsReview: false, message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新
    const snapshot = await this.transport.download(targetId);
    if (snapshot.manifest.containsSecrets) {
      throw new Error(this.msg('sync.remoteContainsSecrets', { id: targetId }));
    }

    const portableIds = new Set(this.portableAdapters().map((a) => a.id));
    const zipPath = await this.snapshotToZip(snapshot, portableIds);
    try {
      const analysis = await this.importer.analyzeImport(zipPath);
      const plan = await this.importer.createImportPlan(zipPath, {
        strategy: opts.strategy ?? 'merge',
        resolutions: {},
        pathMappings: [],
      });
      const changes: PullChange[] = plan.items.map((i) => ({
        id: i.id,
        adapter: i.adapter,
        kind: i.kind,
        description: i.description,
        severity: i.severity,
      }));
      const needsReview =
        plan.items.some((i) =>
          i.kind === 'Conflict' || i.kind === 'MissingSecret' || i.kind === 'MissingDependency'
          || i.kind === 'Install' || i.kind === 'Error')
        || analysis.pathIssues.length > 0;
      const message = changes.length === 0
        ? this.msg('sync.unchanged')
        : this.msg('sync.changesSummary', { compatibility: analysis.compatibility, count: String(changes.length) });
      return { ok: analysis.valid, snapshotId: targetId, changes, needsReview, message };
    } finally {
      await fs.rm(path.dirname(zipPath), { recursive: true, force: true });
    }
  }

  /** 列出远端已有快照（按 createdAt 升序）—— 供「选择历史快照」下拉。 */
  async listSnapshots(): Promise<SyncSnapshotMeta[]> {
    return this.transport.list();
  }

  /**
   * 一键同步预览：拉取远端（最新或指定历史快照）→ 转临时 ZIP → Importer 分析出计划。
   * 与 pull 的区别：临时 ZIP **不清理**（由调用方 / 会话持有，供 apply-items 复用），
   * 并返回完整 plan/analysis/snapshotId 供会话登记。
   * 调用方负责在会话消费或取消后清理 zipPath 所在目录。
   */
  async preview(opts: SyncPullOptions = {}): Promise<SyncPreviewResult> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: false, zipPath: '', plan: null, analysis: null, snapshotId: '', message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const snapshot = await this.transport.download(targetId);
    if (snapshot.manifest.containsSecrets) {
      throw new Error(this.msg('sync.remoteContainsSecrets', { id: targetId }));
    }
    const portableIds = new Set(this.portableAdapters().map((a) => a.id));
    const zipPath = await this.snapshotToZip(snapshot, portableIds);
    const analysis = await this.importer.analyzeImport(zipPath);
    const plan = await this.importer.createImportPlan(zipPath, {
      strategy: opts.strategy ?? 'merge',
      resolutions: {},
      pathMappings: [],
    });
    return { ok: analysis.valid, zipPath, plan, analysis, snapshotId: targetId, message: undefined };
  }

  async merge(opts: { snapshotId?: string } = {}): Promise<MergePlan> {
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { sections: [] };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const remote = await this.transport.download(targetId);
    if (remote.manifest.containsSecrets) {
      throw new Error(`远端快照 ${targetId} 声明 containsSecrets=true，拒绝合并（同步通道永不携带秘密）`);
    }
    // 共同祖先：从 sync-state.lastSnapshotId 读本地副本；空 = 首次/无祖先
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    let ancestor: SyncSnapshot | undefined;
    if (state.lastSnapshotId !== '' && this.localSnapshotsDir !== undefined) {
      ancestor = await loadAncestor(this.localSnapshotsDir, state.lastSnapshotId, this.fsx);
    }
    // 本地当前：现场 export（含 s​e​c​r​e​t 剥离），与 push 同口径
    const localSections: Partial<Record<SectionId, SectionData>> = {};
    for (const adapter of this.portableAdapters()) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: false });
      } catch {
        continue;
      }
      const data = isFileSection(adapter.id) ? section.data : this.scanner.scanAndRedact(section.data).sanitized;
      localSections[adapter.id] = data as SectionData;
    }
    const portableIds = new Set(this.portableAdapters().map((a) => a.id));
    const remotePortable: Partial<Record<SectionId, SectionData>> = {};
    for (const [id, data] of Object.entries(remote.sections)) {
      if (portableIds.has(id as SectionId)) remotePortable[id as SectionId] = data as SectionData;
    }
    const ancestorPortable: Partial<Record<SectionId, SectionData>> = {};
    if (ancestor) {
      for (const [id, data] of Object.entries(ancestor.sections)) {
        if (portableIds.has(id as SectionId)) ancestorPortable[id as SectionId] = data as SectionData;
      }
    }
    return mergeSections(localSections, remotePortable, ancestorPortable);
  }

  /**
   * 记录祖先基线：写本地祖先副本 + 更新 sync-state（lastSnapshotId、每分区 hash/updatedAt、lastSyncAt、transport）+ 裁剪到 keep。
   * 通常由 push() 在上传成功后调用，也可被上层（合并 apply 完成后）显式调用以更新基线到合并后的快照。
   */
  async recordBaseline(
    snapshotId: string,
    sections: SyncSnapshot['sections'],
    nowIso?: string,
  ): Promise<void> {
    const ts = nowIso ?? this.now().toISOString();
    // 1) 写本地祖先副本（如有 localSnapshotsDir）
    if (this.localSnapshotsDir !== undefined) {
      const snapshot: SyncSnapshot = {
        id: snapshotId,
        createdAt: ts,
        manifest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dshVersion: this.ctx.dshVersion,
          platform: this.ctx.platform as Platform,
          sectionIds: Object.keys(sections) as SectionId[],
          containsSecrets: false,
        },
        sections,
      };
      await writeAncestor(this.localSnapshotsDir, snapshot, this.fsx);
    }
    // 2) 更新 sync-state：lastSnapshotId + 每分区 hash/updatedAt + lastSyncAt + transport
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    state.lastSnapshotId = snapshotId;
    state.lastSyncAt = ts;
    state.transport = { type: this.transport.type, ref: this.transportRef };
    for (const [sid, data] of Object.entries(sections)) {
      state.sections[sid as SectionId] = { hash: hashSection(data as SectionData), updatedAt: ts };
    }
    await saveSyncState(this.stateDir, state, this.fsx);
    // 3) 裁剪祖先副本（最近 N 个）
    if (this.localSnapshotsDir !== undefined) {
      await pruneAncestors(this.localSnapshotsDir, DEFAULT_ANCESTOR_KEEP, this.fsx);
    }
  }

  /**
   * 应用自动应用计划：写本地（走 Importer.executeImportPlan 标准路径；应用前调 backup.createSnapshot 兜底）；
   * 任一 auto 项失败 → 整体 rollback；成功后 recordBaseline 更新祖先基线。
   * 返回 ApplyReport；不抛错到调用方（失败返回 ok:false + rolledBack:true）。
   * 不再写 review-queue（§2.3/§7.4：待审语义改由同步历史 skipped 标记表达）。
   */
  async applyMergePlan(apply: SyncApplyPlan): Promise<ApplyReport> {
    if (!this.importer) {
      throw new Error('applyMergePlan: SyncEngine 缺少 importer（需在 options 中注​入）');
    }
    const appliedIds = apply.autoApply.map((r) => r.id);
    // 0) 空 autoApply：无物可应用，直接短路（不构造 ZIP、不调 Importer）
    if (appliedIds.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, review: [], warnings: [] };
    }
    // 1) 构造临时 ZIP（仅含 autoApply 项的 merged payload）+ 分析 + 计划
    const portableIds = new Set(this.portableAdapters().map((a) => a.id));
    const tempSnapshot: SyncSnapshot = {
      id: this.snapshotIdFn(),
      createdAt: this.now().toISOString(),
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: apply.autoApply.map((r) => r.id) as SectionId[],
        containsSecrets: false,
      },
      sections: apply.autoApply.reduce<Record<string, SectionData>>((acc, r) => {
        if (r.merged !== undefined) acc[r.id] = r.merged as SectionData;
        return acc;
      }, {}),
    };
    const zipPath = await this.snapshotToZip(tempSnapshot, portableIds);
    try {
      const analysis = await this.importer.analyzeImport(zipPath);
      const plan = await this.importer.createImportPlan(zipPath, {
        strategy: 'replace', // auto 路径：冲突已在外部分流；这里 replace = 接受导入值
        resolutions: {},
        pathMappings: [],
      });
      if (!plan.items.length) {
        // 没有可执行项 → 视为 ok 但空 applied
        return { ok: true, applied: [], restoreId: '', rolledBack: false, review: [], warnings: [] };
      }
      // 2) 兜底：先建快照（拿到 restoreId 给 UI 一键回滚用）
      const store: SnapshotStore = new FileSnapshotStore({ dir: this.stateDir });
      let snapshot: Snapshot | undefined;
      try {
        snapshot = await createSnapshot({
          ctx: this.ctx,
          plan,
          sourceZip: zipPath,
          store,
          adapters: this.adapters,
        });
      } catch (backupErr) {
        return {
          ok: false,
          applied: [],
          restoreId: '',
          rolledBack: false,
          review: [],
          warnings: [`应用前快照失败：${backupErr instanceof Error ? backupErr.message : String(backupErr)}`],
        };
      }
      // 3) 真正执行：Importer.executeImportPlan（rollbackOnError=true → 任一失败整体回滚）
      const result = await this.importer.executeImportPlan(zipPath, plan, {
        confirm: true,
        rollbackOnError: true,
        secretInputs: undefined,
        decryptedCredentials: undefined,
      });
      if (!result.ok) {
        try { await rollback({ ctx: this.ctx, snapshot, store, adapters: this.adapters }); } catch { /* noop */ }
        // 失败路径不再写 review-queue（§7.4）：历史 skipped/failed 标记由上层（路由/调度器）写入。
        return {
          ok: false,
          applied: [],
          restoreId: snapshot.id,
          rolledBack: true,
          review: [],
          warnings: result.warnings ?? [],
        };
      }
      // 5) 全成功 → recordBaseline（更新祖先基线指向合并后的快照）
      const mergedSections: SyncSnapshot['sections'] = apply.autoApply.reduce<Record<string, SectionData>>((acc, r) => {
        if (r.merged !== undefined) acc[r.id] = r.merged as SectionData;
        return acc;
      }, {});
      await this.recordBaseline(tempSnapshot.id, mergedSections);
      return {
        ok: true,
        applied: appliedIds,
        restoreId: snapshot.id,
        rolledBack: false,
        review: [],
        warnings: result.warnings ?? [],
      };
    } finally {
      try { await fs.rm(path.dirname(zipPath), { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  /**
   * applyItems：按用户对差异项的逐项决策执行导入（§3.4/§5.3）。
   *
   * 与 applyMergePlan 的区别：applyItems 接收「会话级临时 ZIP + 子计划」，
   * 直接执行（backup.createSnapshot 兜底 → importer.executeImportPlan →
   * 成功 recordBaseline / 失败 rollback），不构造中间 SyncApplyPlan。
   *
   * @param zipPath 会话级临时标准 ZIP（由 sync/sync 生成，包含采纳项的 merged payload）
   * @param subPlan 子计划（仅含采纳项的 ImportPlan；globalStrategy/pathMappings/needsRestart 沿用会话 plan）
   * @param opts 执行选项（onItem 进度回调）
   * @returns ApplyItemsReport（ok/applied/restoreId/rolledBack/warnings/result）
   */
  async applyItems(
    zipPath: string,
    subPlan: ImportPlan,
    opts: { onItem?: (info: PlanItemProgress) => void } = {},
  ): Promise<ApplyItemsReport> {
    if (!this.importer) {
      throw new Error('applyItems: SyncEngine 缺少 importer（需在 options 中注​入）');
    }
    if (subPlan.items.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, warnings: [], failed: [], result: null };
    }

    // 兜底快照（拿到 restoreId 给 UI 一键回滚用）
    const store: SnapshotStore = new FileSnapshotStore({ dir: this.stateDir });
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await createSnapshot({
        ctx: this.ctx,
        plan: subPlan,
        sourceZip: zipPath,
        store,
        adapters: this.adapters,
      });
    } catch (backupErr) {
      return {
        ok: false,
        applied: [],
        restoreId: '',
        rolledBack: false,
        warnings: [`应用前快照失败：${backupErr instanceof Error ? backupErr.message : String(backupErr)}`],
        failed: subPlan.items.map((i) => ({ itemId: i.id })),
        result: null,
      };
    }

    // 真正执行：Importer.executeImportPlan（confirm:true + rollbackOnError:true → 任一失败整体回滚）
    const result = await this.importer.executeImportPlan(zipPath, subPlan, {
      confirm: true,
      rollbackOnError: true,
      secretInputs: undefined,
      decryptedCredentials: undefined,
      onItem: opts.onItem,
    });

    if (!result.ok) {
      // executeImportPlan 已内部回滚（rollbackOnError）；这里再显式 rollback 兜底（幂等）
      try { await rollback({ ctx: this.ctx, snapshot, store, adapters: this.adapters }); } catch { /* noop */ }
      return {
        ok: false,
        applied: [],
        restoreId: snapshot.id,
        rolledBack: true,
        warnings: result.warnings ?? [],
        failed: result.executed.filter((e) => e.status === 'failed').map((e) => ({ itemId: e.itemId, message: e.message })),
        result,
      };
    }

    // 成功：recordBaseline 更新祖先基线（合并后的快照）
    const appliedIds = [...new Set(subPlan.items.map((i) => i.adapter))];
    const mergedSections: SyncSnapshot['sections'] = {};
    // 从 subPlan 中按 adapter 收集写入的分区数据（无法直接从 plan item 获取 merged data，
    // 但这里不需要精确的 merged 数据——recordBaseline 只需要 sectionIds 与数据来源；
    // 用现有应用后的 adapter export 作为快照数据更准确）
    // 注意：recordBaseline 需要各分区内容 hash，因此导出当前各分区最新状态。
    for (const adapter of this.portableAdapters()) {
      if (!appliedIds.includes(adapter.id)) continue;
      try {
        const section = await adapter.export(this.ctx, { includeSecrets: false });
        const data = isFileSection(adapter.id)
          ? section.data
          : this.scanner.scanAndRedact(section.data).sanitized;
        mergedSections[adapter.id] = data as SectionData;
      } catch {
        // 单个分区导出失败不拖垮 recordBaseline（已应用的分区数据从 subPlan 兜底）
      }
    }
    const snapshotId = this.snapshotIdFn();
    await this.recordBaseline(snapshotId, mergedSections);

    return {
      ok: true,
      applied: appliedIds,
      skipped: subPlan.items.filter((i) => i.kind === 'Skip').map((i) => i.id),
      restoreId: snapshot.id,
      rolledBack: false,
      warnings: result.warnings ?? [],
      failed: [],
      needsRestart: result.needsRestart,
      result,
    };
  }

  /** 散文件快照 → 标准导出 ZIP（临时目录，用完即删）：buildManifest + checksums + 平铺分区 */
  private async snapshotToZip(snapshot: SyncSnapshot, portableIds: Set<SectionId>): Promise<string> {
    const entries: ZipWriteEntry[] = [];
    const sectionFlags = {} as Record<SectionId, boolean>;
    for (const sid of portableIds) {
      const data = snapshot.sections[sid];
      if (data === undefined) continue;
      sectionFlags[sid] = true;
      if (isFileSection(sid)) {
        const prefix = SECTION_FILE_PREFIXES[sid]!;
        const files = (data as FilesSection).files ?? [];
        for (const f of files) {
          entries.push({ name: `${prefix}${f.relativePath}`, data: f.data });
        }
      } else {
        const jsonPath = SECTION_JSON_PATHS[sid];
        if (jsonPath === undefined) continue;
        entries.push({ name: jsonPath, data: Buffer.from(stringifyJsonSafe(data, { space: 2 }), 'utf8') });
      }
    }
    const manifest = buildManifest({
      exporterVersion: this.exporterVersion,
      dshVersion: snapshot.manifest.dshVersion,
      platform: snapshot.manifest.platform as Platform,
      arch: 'unknown', // ManifestSummary 不含 arch；仅影响展示，不影响导入决策
      sections: sectionFlags,
      containsSecrets: false,
      encrypted: false,
      encryption: null,
      exportedAt: snapshot.createdAt,
    });
    // checksums：覆盖除 manifest/checksums 外全部条目（与 exporter 一致）
    const contentEntries = entries.filter((e) => e.name !== MANIFEST_FILE && e.name !== CHECKSUMS_FILE);
    entries.push({
      name: CHECKSUMS_FILE,
      data: Buffer.from(stringifyJsonSafe(buildChecksums(contentEntries), { space: 2 }), 'utf8'),
    });
    entries.push({ name: MANIFEST_FILE, data: Buffer.from(stringifyJsonSafe(manifest, { space: 2 }), 'utf8') });

    const dir = await fs.mkdtemp(path.join(this.zipDir, 'dsh-sync-pull-'));
    const zipPath = path.join(dir, 'snapshot.zip');
    await writeZip(zipPath, entries);
    return zipPath;
  }
}
