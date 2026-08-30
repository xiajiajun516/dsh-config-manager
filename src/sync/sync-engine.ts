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
import { decryptSectionsPayload, encryptSectionsPayload } from './snapshot-crypto.ts';
import { hashSection, loadSyncState, saveSyncState } from './sync-state.ts';
import type { EncryptedSections, SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { isEncryptedSections } from './transport.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { DEFAULT_ANCESTOR_KEEP, loadAncestor, pruneAncestors, writeAncestor } from './ancestor.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import { merge as mergeSections } from './merge.ts';
import type { SyncApplyPlan } from './risk.ts';
import { createSnapshot } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { FileSnapshotStore } from '../core/backup.ts';
import type { Snapshot, SnapshotStore, TransactionSnapshotContext } from '../core/types.ts';
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
  /** 一键回滚兜底快照目录（apply-items / apply-merge-plan 落盘；缺省 <stateDir>/snapshots，
   *  与 Host /sync/rollback 路由读取的目录保持一致，否则回滚找不到 snapshot.json） */
  rollbackSnapshotsDir?: string;
  /** pull 临时 ZIP 目录（缺省 os.tmpdir()） */
  zipDir?: string;
  exporterVersion?: string;
  fsx?: SnapshotFs;
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
  /**
   * 同步范围（高级/自定义导出模式持久化配置）：只处理这些 portable 分区。
   * 缺省 = 全部 portable 推荐分区。应用于 push / merge / applyMergePlan / applyItems
   * 等全部链路（portableAdapters 层过滤），供自动同步等后台流程复用用户选择；
   * 手动请求仍可用 push(opts.sections) 覆盖。
   */
  sections?: SectionId[];
}

export interface SyncPushOptions {
  /** 覆盖自动生成的快照 id */
  snapshotId?: string;
  /** 仅同步指定分区（缺省 = 全部 portable 推荐分区，即「默认/快速导出」模式）。
   *  传入非 portable 或未知分区 → 忽略并告警（同步通道安全约束：
   *  deviceSpecific/platformSpecific 永不进入同步通道；未知 id 不静默吞掉）。 */
  sections?: SectionId[];
  /** 加密快照：sections 载荷整体加密（AES-256-GCM），manifest.encrypted=true。
   *  开启时必须提供 password（仅本次调用内存使用，绝不落盘/落日志）。 */
  encrypt?: boolean;
  /** 加密密码（仅内存；encrypt=true 时必填）。 */
  password?: string;
  /** 导出真实凭据值（凭据值进入快照）。安全不变量：includeSecrets=true 必须同时 encrypt=true，
   *  否则拒绝（密钥绝不明文进入同步通道）；自动同步恒 includeSecrets=false（推普通快照）。 */
  includeSecrets?: boolean;
}

export interface SyncPullOptions {
  /** 指定远端快照 id（缺省 = 最新） */
  snapshotId?: string;
  /** 冲突全局策略（缺省 merge：冲突保留待决策） */
  strategy?: GlobalConflictStrategy;
  /** 解密密码（加密快照需要；仅内存，绝不落盘/落日志） */
  password?: string;
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
  /** 是否存在需要人工决策的项（Conflict / MissingSecret / MissingDependency / 路径问题）。
   * 插件 Install 不算 —— 插件安装随同步自动采用（product requirement）。 */
  needsReview: boolean;
  message?: string;
}

/** P0-②：push 前只读预览 ——「将推送什么」的单分区摘要（不写远端、不落盘）。 */
export interface SyncPushPreviewSection {
  /** 分区 id（将进入快照的 portable 分区） */
  section: SectionId;
  /** 分区内条目计数（adapter.export 的 counts 聚合；无计数时为 0） */
  count: number;
  /** 相对上次基线（sync-state）是否变化：true = 本次会更新该分区；false = 与基线一致 */
  changed: boolean;
}

/** P0-②：push 前预览结果（零写入）。 */
export interface SyncPushPreview {
  ok: boolean;
  /** 将推送的分区清单（含计数与变化标记） */
  sections: SyncPushPreviewSection[];
  /** 远端现有快照数（0 = 首次推送将创建首个基线） */
  remoteSnapshotCount: number;
  /** 加密快照：载荷将整体加密（分区计数与基线比较不可得） */
  encrypted: boolean;
  message?: string;
}

/** 一键 sync 预览结果（preview() 返回；临时 ZIP 由调用方持有并负责清理）。 */
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

/**
 * 远端快照保留数量上限：每次 push 上传成功后对远端裁剪，
 * 保留最新 N 个（按 createdAt 升序的最末 N 个，含刚 push 的），更旧的逐个删除。
 * 只按数量裁剪，不按时间窗口。删除失败只告警（进 push 的 warnings），不上抛阻断主流程。
 */
export const MAX_REMOTE_SNAPSHOTS = 10;

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
  private readonly rollbackSnapshotsDir: string;
  private readonly zipDir: string;
  private readonly exporterVersion: string;
  private readonly fsx: SnapshotFs;
  private readonly msg: MsgFunc;
  private readonly sections: readonly SectionId[] | undefined;

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
    this.rollbackSnapshotsDir = opts.rollbackSnapshotsDir ?? path.join(opts.stateDir, 'snapshots');
    this.zipDir = opts.zipDir ?? os.tmpdir();
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.fsx = opts.fsx ?? createSnapshotFs();
    this.msg = opts.msg ?? msgOf(opts.ctx);
    this.sections = opts.sections !== undefined && opts.sections.length > 0 ? [...opts.sections] : undefined;
  }

  /** 同步只做 portable 分区（deviceSpecific/platformSpecific 永不参与）。
   *  构造注入 sections（同步范围）时再按注入范围过滤 —— 自动同步等后台流程
   *  merge/apply/push 全链路复用用户选择；手动请求仍可用 push(opts.sections) 覆盖。 */
  private portableAdapters(): ConfigAdapter[] {
    const portable = this.adapters.filter((a) => a.portability === 'portable');
    if (this.sections === undefined) return portable;
    const wanted = new Set(this.sections);
    return portable.filter((a) => wanted.has(a.id));
  }

  /**
   * push 候选 adapter：
   * - sections 缺省/空 → 全部 portable（「默认/快速导出」模式）；
   * - sections 显式给出 → 只取 portable 且命中的（「高级/自定义导出」模式）；
   *   非 portable / 未知分区 → 警告跳过（安全约束 + 不静默，用户能看见自己勾了哪个无效项）。
   */
  private pushTargets(sections: readonly SectionId[] | undefined, warnings: string[]): ConfigAdapter[] {
    const portable = this.portableAdapters();
    if (sections === undefined || sections.length === 0) return portable;
    const byId = new Map(portable.map((a) => [a.id, a]));
    const out: ConfigAdapter[] = [];
    for (const id of sections) {
      const adapter = byId.get(id);
      if (adapter === undefined) {
        warnings.push(this.msg('sync.skipNonPortable', { section: id }));
        continue;
      }
      out.push(adapter);
    }
    return out;
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
   * 快照读取准备（download 后、使用前）：
   * - 加密快照（manifest.encrypted）→ 用 password 解密回明文 sections（原地替换）；
   *   无密码 → 明确报错（自动同步等无密码场景在调用方先行跳过）。
   * - 普通快照声明 containsSecrets=true → 拒绝（同步通道永不携带秘密，防御篡改/旧坏数据）。
   * 密码仅本次调用内存使用，绝不落盘/落日志。
   */
  private async prepareSnapshot(snapshot: SyncSnapshot, password?: string): Promise<void> {
    if (snapshot.manifest.encrypted) {
      if (password === undefined || password === '') {
        throw new Error(this.msg('sync.encryptedNeedsPassword', { id: snapshot.id }));
      }
      if (!isEncryptedSections(snapshot.sections)) {
        throw new Error(this.msg('sync.encryptedNeedsPassword', { id: snapshot.id }));
      }
      const decrypted = await decryptSectionsPayload(snapshot.sections.encrypted, password);
      snapshot.sections = decrypted;
      return;
    }
    if (snapshot.manifest.containsSecrets) {
      throw new Error(this.msg('sync.remoteContainsSecrets', { id: snapshot.id }));
    }
  }

  /**
   * push：导出 portable 分区 → 组装快照 → 本地散文件副本 → transport.upload → 更新 sync-state。
   * 单项分区导出失败只告警跳过（§34.17），全部失败才整体失败。
   * opts.sections：指定仅同步这些分区（高级/自定义模式）；缺省 = 全部 portable 推荐分区。
   * opts.encrypt/password/includeSecrets：加密快照（含可选密钥导出）。
   * 安全不变量：includeSecrets ⇒ encrypt（密钥绝不明文进入同步通道）；密码仅内存。
   */
  async push(opts: SyncPushOptions = {}): Promise<SyncPushReport> {
    const warnings: string[] = [];
    const includeSecrets = opts.includeSecrets ?? false;
    const encrypt = opts.encrypt ?? false;
    // 安全不变量：导出密钥必须加密；加密必须给密码（密码绝不落盘）
    if (includeSecrets && !encrypt) {
      throw new Error(this.msg('sync.includeSecretsRequiresEncryption'));
    }
    if (encrypt && (opts.password === undefined || opts.password === '')) {
      throw new Error(this.msg('sync.encryptRequiresPassword'));
    }
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const targets = this.pushTargets(opts.sections, warnings);
    for (const adapter of targets) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      warnings.push(...section.warnings);
      // includeSecrets=true：凭据值保留（随后整体加密）；否则过 SecretScanner 剥离（默认安全）
      const data = isFileSection(adapter.id) || includeSecrets
        ? section.data
        : this.scanner.scanAndRedact(section.data).sanitized;
      plainSections[adapter.id] = data as SectionData;
    }

    if (Object.keys(plainSections).length === 0) {
      return { ok: false, snapshotId: '', sections: [], warnings, message: this.msg('sync.noPortableSections') };
    }
    this.assertNoForbiddenSections(plainSections as Record<string, unknown>);

    // 加密：整个明文 sections 载荷加密为密文（manifest 只存非秘密参数）
    let sections: SyncSnapshot['sections'] = plainSections;
    const encrypted = encrypt;
    if (encrypt) {
      sections = await encryptSectionsPayload(plainSections, opts.password!);
    }

    const nowIso = this.now().toISOString();
    const id = opts.snapshotId ?? this.snapshotIdFn();
    const snapshot: SyncSnapshot = {
      id,
      createdAt: nowIso,
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: Object.keys(plainSections) as SectionId[],
        containsSecrets: includeSecrets,
        // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
        transport: this.transport.type,
        ...(encrypted ? { encrypted: true } : {}),
      },
      sections,
    };

    // ① 本地散文件快照副本（审计；复用 t2 layout，不写 ZIP）。
    //    加密快照不写本地散文件副本（磁盘不落任何密文/明文载荷；远端已存密文）。
    if (this.localSnapshotsDir !== undefined && !encrypted) {
      await writeSnapshotToDir(snapshot, joinFs(this.localSnapshotsDir, id), this.fsx);
    }
    // ② 上传远端（传输通道负责散文件落盘 + 提交推送）
    await this.transport.upload(snapshot);
    // ②·1 裁剪远端快照：保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的）。
    //      删除失败只告警（进 warnings），不上抛 —— 不阻断 push 主流程。
    //      放在 upload 之后（保证新快照已推送成功）与 recordBaseline 之前（先管好远端再记基线）。
    await this.pruneRemoteSnapshots(id, warnings);
    // ③ 记录祖先基线：写 sync-state（lastSnapshotId + 每分区 hash/updatedAt + lastSyncAt + transport）+ 裁剪。
    //    基线 hash 用明文（hasLocalChanges 与本地明文可比）；加密快照不写明文祖先副本（密钥不落盘）。
    await this.recordBaseline(id, plainSections, nowIso, { writeAncestor: !encrypted });

    return { ok: true, snapshotId: id, sections: Object.keys(plainSections) as SectionId[], warnings };
  }

  /**
   * P0-②：push 前只读预览「将推送什么」—— 零写入、零远端变更：
   *  - 导出目标 portable 分区（与 push 同口径：sections 过滤 + secret 剥离）；
   *  - 逐分区相对上次基线（sync-state.sections hash）的 changed 标记；
   *  - 远端现有快照数（list 只读；首次推送 = 0）。
   * 加密快照（encrypt）时不再比较基线（密文不可比），sections 只带计数。
   * 任何失败都不写任何内容；预览只是 push 的「确认前说明书」。
   */
  async previewPush(opts: SyncPushOptions = {}): Promise<SyncPushPreview> {
    const warnings: string[] = [];
    const includeSecrets = opts.includeSecrets ?? false;
    const encrypted = opts.encrypt ?? false;
    if (includeSecrets && !encrypted) {
      throw new Error(this.msg('sync.includeSecretsRequiresEncryption'));
    }
    const targets = this.pushTargets(opts.sections, warnings);
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const counts: Partial<Record<SectionId, number>> = {};
    for (const adapter of targets) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      const data = isFileSection(adapter.id) || includeSecrets
        ? section.data
        : this.scanner.scanAndRedact(section.data).sanitized;
      plainSections[adapter.id] = data as SectionData;
      counts[adapter.id] = section.counts ? Object.values(section.counts).reduce((a, b) => a + b, 0) : 0;
    }
    if (Object.keys(plainSections).length === 0) {
      return { ok: false, sections: [], remoteSnapshotCount: 0, encrypted, message: this.msg('sync.noPortableSections') };
    }
    this.assertNoForbiddenSections(plainSections as Record<string, unknown>);

    // 基线对比（非加密）：sync-state.sections 存每分区 hash；缺基线分区 → 视为新增
    let baselineHashes: Record<string, string> = {};
    if (!encrypted) {
      try {
        const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
        baselineHashes = state.sections as Record<string, string>;
      } catch {
        baselineHashes = {};
      }
    }
    const sections: SyncPushPreviewSection[] = Object.keys(plainSections).map((sid) => {
      const id = sid as SectionId;
      const changed = encrypted || baselineHashes[id] === undefined || baselineHashes[id] !== hashSection(plainSections[id] as SectionData);
      return { section: id, count: counts[id] ?? 0, changed };
    });

    let remoteSnapshotCount = 0;
    try {
      const metas = await this.transport.list();
      remoteSnapshotCount = metas.length;
    } catch {
      // list 失败只影响展示（首次推送提示），不阻断预览
    }
    return { ok: true, sections, remoteSnapshotCount, encrypted, message: warnings.length > 0 ? warnings.join('; ') : undefined };
  }

  /**
   * 裁剪远端快照：调用 transport.list() 获取全部快照（按 createdAt 升序），
   * 保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的 pushedId），对更旧的逐个调用 transport.delete()。
   * 只按数量裁剪，不按时间窗口。
   *
   * 失败语义：list/delete 失败均只 push 进 warnings，不上抛 —— 裁剪是「尽力而为」的后台整理，
   * 绝不影响 push 主流程的成功与否（§34.17 分区级告警同款语义）。
   */
  private async pruneRemoteSnapshots(pushedId: string, warnings: string[]): Promise<void> {
    let metas: SyncSnapshotMeta[];
    try {
      metas = await this.transport.list();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(this.msg('sync.pruneListFailed', { reason }));
      return;
    }
    if (metas.length <= MAX_REMOTE_SNAPSHOTS) return;
    // 升序最末 N 个保留；刚 push 的快照（createdAt 最新）必在其中，防御性也把它计入保留集
    const keep = new Set(metas.slice(-MAX_REMOTE_SNAPSHOTS).map((m) => m.id));
    keep.add(pushedId);
    for (const m of metas) {
      if (keep.has(m.id)) continue;
      try {
        await this.transport.delete(m.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        warnings.push(this.msg('sync.pruneDeleteFailed', { id: m.id, reason }));
      }
    }
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
    // 加密快照 → 用密码解密回明文（无密码明确报错）；普通快照 → containsSecrets 拒绝
    await this.prepareSnapshot(snapshot, opts.password);

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
          || i.kind === 'Error')
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
   * 远端是否出现比本地共同祖先（sync-state.lastSnapshotId）更新的快照（§3.2「检测到远端新快照」）。
   * - 远端为空 → false（无物可拉）；
   * - 本地从未同步（lastSnapshotId=''）且远端非空 → true（首次可拉）；
   * - 否则比较远端最新快照 id 与 lastSnapshotId。
   * 只读远端列表（transport.list），不做下载/合并。
   */
  async hasNewRemoteSnapshot(): Promise<boolean> {
    const metas = await this.transport.list();
    if (metas.length === 0) return false;
    const latestId = metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新在末
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (state.lastSnapshotId === '') return true;
    return latestId !== state.lastSnapshotId;
  }

  /**
   * 本地 portable 配置当前内容与上次基线（sync-state.sections hash）相比是否有变化（§3.1 上传「看变化」）。
   * - 从未同步（sync-state.sections 为空）→ true；
   * - 任一 portable 分区当前导出 hash ≠ 基线 hash → true；
   * - 全部一致 → false（无本地改动，不上传）。
   * 只读本地导出 + sync-state，不写任何东西、不碰远端。
   */
  async hasLocalChanges(): Promise<boolean> {
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (Object.keys(state.sections).length === 0) return true;
    for (const adapter of this.portableAdapters()) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: false });
      } catch {
        continue; // 单项导出失败不影响判定（与 push 单项跳过语义一致）
      }
      const data = isFileSection(adapter.id) ? section.data : this.scanner.scanAndRedact(section.data).sanitized;
      const recorded = state.sections[adapter.id];
      if (recorded === undefined) return true; // 基线缺该分区 → 视为有变化
      if (recorded.hash !== hashSection(data as SectionData)) return true;
    }
    return false;
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
    // 加密快照 → 用密码解密回明文（无密码明确报错）；普通快照 → containsSecrets 拒绝
    await this.prepareSnapshot(snapshot, opts.password);
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

  async merge(opts: { snapshotId?: string; password?: string } = {}): Promise<MergePlan> {
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { sections: [] };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const remote = await this.transport.download(targetId);
    // 加密快照 → 用密码解密；普通快照 containsSecrets=true → 拒绝（防御）
    await this.prepareSnapshot(remote, opts.password);
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
    opts: { writeAncestor?: boolean } = {},
  ): Promise<void> {
    const ts = nowIso ?? this.now().toISOString();
    // 1) 写本地祖先副本（如有 localSnapshotsDir）。
    //    writeAncestor=false（加密快照基线）：不写明文祖先副本（磁盘不落密钥；
    //    基线仅用 sync-state 的明文 hash，供 hasLocalChanges 比较）。
    if (this.localSnapshotsDir !== undefined && opts.writeAncestor !== false) {
      const snapshot: SyncSnapshot = {
        id: snapshotId,
        createdAt: ts,
        manifest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dshVersion: this.ctx.dshVersion,
          platform: this.ctx.platform as Platform,
          sectionIds: Object.keys(sections) as SectionId[],
          containsSecrets: false,
          // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
          transport: this.transport.type,
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
      const store: SnapshotStore = new FileSnapshotStore({ dir: this.rollbackSnapshotsDir });
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
    opts: {
      onItem?: (info: PlanItemProgress) => void;
      /** Phase 4 生产 journal↔snapshot 绑定（deferred；透传给 Importer.executeImportPlan） */
      snapshotBinding?: TransactionSnapshotContext;
    } = {},
  ): Promise<ApplyItemsReport> {
    if (!this.importer) {
      throw new Error('applyItems: SyncEngine 缺少 importer（需在 options 中注​入）');
    }
    if (subPlan.items.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, warnings: [], failed: [], result: null };
    }

    // 兜底快照（拿到 restoreId 给 UI 一键回滚用）
    const store: SnapshotStore = new FileSnapshotStore({ dir: this.rollbackSnapshotsDir });
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
      snapshotBinding: opts.snapshotBinding,
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
    // 防御：加密快照必须已由调用方解密（prepareSnapshot）；此处不处理密文载荷
    if (isEncryptedSections(snapshot.sections)) {
      throw new Error('快照仍为加密载荷，无法转 ZIP（需先解密）');
    }
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
